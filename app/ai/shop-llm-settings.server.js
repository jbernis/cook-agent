import prisma from "../db.server";
import { decryptSecret, encryptSecret } from "../services/crypto.server";

function obfuscateKeyHint(key) {
  const raw = typeof key === "string" ? key.trim() : "";
  if (!raw) return null;

  // Always use last 8 chars of the whole string (more robust than splitting on '-').
  const suffix = raw.length > 8 ? raw.slice(-8) : raw;
  if (raw.startsWith("sk-")) return `sk-.......-${suffix}`;
  const prefix = raw.slice(0, Math.min(3, raw.length));
  return `${prefix}.......${suffix}`;
}

/**
 * Best-effort: normalize an Origin hostname (myshop.myshopify.com or custom domain).
 * @param {string|null} originHeader
 * @returns {string|null}
 */
export function shopFromOrigin(originHeader) {
  try {
    if (!originHeader) return null;
    const { hostname } = new URL(originHeader);
    return hostname || null;
  } catch {
    return null;
  }
}

/**
 * Fetch per-shop LLM settings (if table exists).
 * Returns null if not configured or table missing.
 * @param {string} shop
 */
export async function getShopLlmSettings(shop) {
  try {
    if (!shop || typeof shop !== "string") return null;

    const rows = await prisma.$queryRaw`
      SELECT
        shop,
        llmProvider,
        defaultModel,
        anthropicApiKeyEnc,
        anthropicApiKeyHint,
        openaiApiKeyEnc,
        openaiApiKeyHint,
        geminiApiKeyEnc,
        geminiApiKeyHint
      FROM ShopLlmSettings
      WHERE shop = ${shop}
      LIMIT 1
    `;

    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row) return null;

    const hasAnthropicApiKey = Boolean(row.anthropicApiKeyEnc);
    const hasOpenAiApiKey = Boolean(row.openaiApiKeyEnc);
    const hasGeminiApiKey = Boolean(row.geminiApiKeyEnc);

    let anthropicApiKey = null;
    try {
      anthropicApiKey = row.anthropicApiKeyEnc ? decryptSecret(row.anthropicApiKeyEnc) : null;
    } catch {
      // If decryption fails (missing key), treat as not configured
      anthropicApiKey = null;
    }

    let openaiApiKey = null;
    try {
      openaiApiKey = row.openaiApiKeyEnc ? decryptSecret(row.openaiApiKeyEnc) : null;
    } catch {
      openaiApiKey = null;
    }

    let geminiApiKey = null;
    try {
      geminiApiKey = row.geminiApiKeyEnc ? decryptSecret(row.geminiApiKeyEnc) : null;
    } catch {
      geminiApiKey = null;
    }

    return {
      shop: row.shop,
      llmProvider: row.llmProvider || null,
      defaultModel: row.defaultModel || null,
      hasAnthropicApiKey,
      anthropicApiKey,
      anthropicApiKeyHint:
        typeof row.anthropicApiKeyHint === "string" && row.anthropicApiKeyHint.trim()
          ? row.anthropicApiKeyHint.trim()
          : null,
      hasOpenAiApiKey,
      openaiApiKey,
      openaiApiKeyHint:
        typeof row.openaiApiKeyHint === "string" && row.openaiApiKeyHint.trim()
          ? row.openaiApiKeyHint.trim()
          : null,
      hasGeminiApiKey,
      geminiApiKey,
      geminiApiKeyHint:
        typeof row.geminiApiKeyHint === "string" && row.geminiApiKeyHint.trim()
          ? row.geminiApiKeyHint.trim()
          : null,
    };
  } catch (e) {
    // If the migration hasn't run yet, SQLite will throw "no such table"
    if (String(e?.message || "").toLowerCase().includes("no such table")) return null;
    throw e;
  }
}

/**
 * Upsert per-shop LLM settings.
 * Requires APP_SETTINGS_ENCRYPTION_KEY to be set (encryption).
 * @param {object} params
 * @param {string} params.shop
 * @param {string} params.llmProvider
 * @param {string} params.defaultModel
 * @param {string} params.anthropicApiKey
 */
export async function upsertShopLlmSettings({
  shop,
  llmProvider,
  defaultModel,
  anthropicApiKey,
  openaiApiKey,
  geminiApiKey,
}) {
  if (!shop || typeof shop !== "string") throw new Error("Missing shop");

  const provider = typeof llmProvider === "string" && llmProvider.trim() ? llmProvider.trim() : "anthropic";
  const model = typeof defaultModel === "string" && defaultModel.trim() ? defaultModel.trim() : null;
  const key = typeof anthropicApiKey === "string" && anthropicApiKey.trim() ? anthropicApiKey.trim() : null;

  // If the user leaves the key blank in the UI, keep the existing key.
  // (So they can update provider/model without having to re-enter secrets.)
  const encryptedKey = key ? encryptSecret(key) : null;
  const hint = key ? obfuscateKeyHint(key) : null;

  const openaiKey = typeof openaiApiKey === "string" && openaiApiKey.trim() ? openaiApiKey.trim() : null;
  const openaiEnc = openaiKey ? encryptSecret(openaiKey) : null;
  const openaiHint = openaiKey ? obfuscateKeyHint(openaiKey) : null;

  const geminiKey = typeof geminiApiKey === "string" && geminiApiKey.trim() ? geminiApiKey.trim() : null;
  const geminiEnc = geminiKey ? encryptSecret(geminiKey) : null;
  const geminiHint = geminiKey ? obfuscateKeyHint(geminiKey) : null;

  try {
    // SQLite upsert (ON CONFLICT)
    await prisma.$executeRaw`
      INSERT INTO ShopLlmSettings (
        shop,
        llmProvider,
        defaultModel,
        anthropicApiKeyEnc,
        anthropicApiKeyHint,
        openaiApiKeyEnc,
        openaiApiKeyHint,
        geminiApiKeyEnc,
        geminiApiKeyHint,
        createdAt,
        updatedAt
      )
      VALUES (
        ${shop},
        ${provider},
        ${model},
        ${encryptedKey},
        ${hint},
        ${openaiEnc},
        ${openaiHint},
        ${geminiEnc},
        ${geminiHint},
        datetime('now'),
        datetime('now')
      )
      ON CONFLICT(shop) DO UPDATE SET
        llmProvider = excluded.llmProvider,
        defaultModel = excluded.defaultModel,
        anthropicApiKeyEnc = COALESCE(excluded.anthropicApiKeyEnc, anthropicApiKeyEnc),
        anthropicApiKeyHint = COALESCE(excluded.anthropicApiKeyHint, anthropicApiKeyHint),
        openaiApiKeyEnc = COALESCE(excluded.openaiApiKeyEnc, openaiApiKeyEnc),
        openaiApiKeyHint = COALESCE(excluded.openaiApiKeyHint, openaiApiKeyHint),
        geminiApiKeyEnc = COALESCE(excluded.geminiApiKeyEnc, geminiApiKeyEnc),
        geminiApiKeyHint = COALESCE(excluded.geminiApiKeyHint, geminiApiKeyHint),
        updatedAt = datetime('now')
    `;
  } catch (e) {
    if (String(e?.message || "").toLowerCase().includes("no such table")) {
      throw new Error("Missing DB table ShopLlmSettings. Run Prisma migrations, then try again.");
    }
    throw e;
  }
}

import prisma from "../db.server";
import { decryptSecret, encryptSecret } from "../services/crypto.server";

function obfuscateKeyHint(key) {
  const raw = typeof key === "string" ? key.trim() : "";
  if (!raw) return null;

  // Always use last 8 chars of the whole string (more robust than splitting on '-').
  const suffix = raw.length > 8 ? raw.slice(-8) : raw;
  if (raw.startsWith("sk-")) return `sk-.......-${suffix}`;
  const prefix = raw.slice(0, Math.min(3, raw.length));
  return `${prefix}.......${suffix}`;
}

/**
 * Best-effort: normalize an Origin hostname (myshop.myshopify.com or custom domain).
 * @param {string|null} originHeader
 * @returns {string|null}
 */
export function shopFromOrigin(originHeader) {
  try {
    if (!originHeader) return null;
    const { hostname } = new URL(originHeader);
    return hostname || null;
  } catch {
    return null;
  }
}

/**
 * Fetch per-shop LLM settings (if table exists).
 * Returns null if not configured or table missing.
 * @param {string} shop
 */
export async function getShopLlmSettings(shop) {
  try {
    if (!shop || typeof shop !== "string") return null;

    const rows = await prisma.$queryRaw`
      SELECT
        shop,
        llmProvider,
        defaultModel,
        anthropicApiKeyEnc,
        anthropicApiKeyHint,
        openaiApiKeyEnc,
        openaiApiKeyHint,
        geminiApiKeyEnc,
        geminiApiKeyHint
      FROM ShopLlmSettings
      WHERE shop = ${shop}
      LIMIT 1
    `;

    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row) return null;

    const hasAnthropicApiKey = Boolean(row.anthropicApiKeyEnc);
    const hasOpenAiApiKey = Boolean(row.openaiApiKeyEnc);
    const hasGeminiApiKey = Boolean(row.geminiApiKeyEnc);

    let anthropicApiKey = null;
    try {
      anthropicApiKey = row.anthropicApiKeyEnc
        ? decryptSecret(row.anthropicApiKeyEnc)
        : null;
    } catch {
      // If decryption fails (missing key), treat as not configured
      anthropicApiKey = null;
    }

    let openaiApiKey = null;
    try {
      openaiApiKey = row.openaiApiKeyEnc ? decryptSecret(row.openaiApiKeyEnc) : null;
    } catch {
      openaiApiKey = null;
    }

    let geminiApiKey = null;
    try {
      geminiApiKey = row.geminiApiKeyEnc ? decryptSecret(row.geminiApiKeyEnc) : null;
    } catch {
      geminiApiKey = null;
    }

    return {
      shop: row.shop,
      llmProvider: row.llmProvider || null,
      defaultModel: row.defaultModel || null,
      hasAnthropicApiKey,
      anthropicApiKey,
      anthropicApiKeyHint:
        typeof row.anthropicApiKeyHint === "string" && row.anthropicApiKeyHint.trim()
          ? row.anthropicApiKeyHint.trim()
          : null,
      hasOpenAiApiKey,
      openaiApiKey,
      openaiApiKeyHint:
        typeof row.openaiApiKeyHint === "string" && row.openaiApiKeyHint.trim()
          ? row.openaiApiKeyHint.trim()
          : null,
      hasGeminiApiKey,
      geminiApiKey,
      geminiApiKeyHint:
        typeof row.geminiApiKeyHint === "string" && row.geminiApiKeyHint.trim()
          ? row.geminiApiKeyHint.trim()
          : null,
    };
  } catch (e) {
    // If the migration hasn't run yet, SQLite will throw "no such table"
    if (String(e?.message || "").toLowerCase().includes("no such table")) return null;
    throw e;
  }
}

/**
 * Upsert per-shop LLM settings.
 * Requires APP_SETTINGS_ENCRYPTION_KEY to be set (encryption).
 * @param {object} params
 * @param {string} params.shop
 * @param {string} params.llmProvider
 * @param {string} params.defaultModel
 * @param {string} params.anthropicApiKey
 */
export async function upsertShopLlmSettings({
  shop,
  llmProvider,
  defaultModel,
  anthropicApiKey,
  openaiApiKey,
  geminiApiKey,
}) {
  if (!shop || typeof shop !== "string") throw new Error("Missing shop");

  const provider =
    typeof llmProvider === "string" && llmProvider.trim() ? llmProvider.trim() : "anthropic";
  const model =
    typeof defaultModel === "string" && defaultModel.trim() ? defaultModel.trim() : null;
  const key =
    typeof anthropicApiKey === "string" && anthropicApiKey.trim() ? anthropicApiKey.trim() : null;

  // If the user leaves the key blank in the UI, keep the existing key.
  // (So they can update provider/model without having to re-enter secrets.)
  const encryptedKey = key ? encryptSecret(key) : null;
  const hint = key ? obfuscateKeyHint(key) : null;

  const openaiKey =
    typeof openaiApiKey === "string" && openaiApiKey.trim() ? openaiApiKey.trim() : null;
  const openaiEnc = openaiKey ? encryptSecret(openaiKey) : null;
  const openaiHint = openaiKey ? obfuscateKeyHint(openaiKey) : null;

  const geminiKey =
    typeof geminiApiKey === "string" && geminiApiKey.trim() ? geminiApiKey.trim() : null;
  const geminiEnc = geminiKey ? encryptSecret(geminiKey) : null;
  const geminiHint = geminiKey ? obfuscateKeyHint(geminiKey) : null;

  try {
    // SQLite upsert (ON CONFLICT)
    await prisma.$executeRaw`
      INSERT INTO ShopLlmSettings (
        shop,
        llmProvider,
        defaultModel,
        anthropicApiKeyEnc,
        anthropicApiKeyHint,
        openaiApiKeyEnc,
        openaiApiKeyHint,
        geminiApiKeyEnc,
        geminiApiKeyHint,
        createdAt,
        updatedAt
      )
      VALUES (
        ${shop},
        ${provider},
        ${model},
        ${encryptedKey},
        ${hint},
        ${openaiEnc},
        ${openaiHint},
        ${geminiEnc},
        ${geminiHint},
        datetime('now'),
        datetime('now')
      )
      ON CONFLICT(shop) DO UPDATE SET
        llmProvider = excluded.llmProvider,
        defaultModel = excluded.defaultModel,
        anthropicApiKeyEnc = COALESCE(excluded.anthropicApiKeyEnc, anthropicApiKeyEnc),
        anthropicApiKeyHint = COALESCE(excluded.anthropicApiKeyHint, anthropicApiKeyHint),
        openaiApiKeyEnc = COALESCE(excluded.openaiApiKeyEnc, openaiApiKeyEnc),
        openaiApiKeyHint = COALESCE(excluded.openaiApiKeyHint, openaiApiKeyHint),
        geminiApiKeyEnc = COALESCE(excluded.geminiApiKeyEnc, geminiApiKeyEnc),
        geminiApiKeyHint = COALESCE(excluded.geminiApiKeyHint, geminiApiKeyHint),
        updatedAt = datetime('now')
    `;
  } catch (e) {
    if (String(e?.message || "").toLowerCase().includes("no such table")) {
      throw new Error(
        "Missing DB table ShopLlmSettings. Run Prisma migrations, then try again."
      );
    }
    throw e;
  }
}


