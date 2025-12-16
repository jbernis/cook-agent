import { useMemo, useRef, useState } from "react";
import { redirect, useLoaderData } from "react-router";

const I18N = {
  en: {
    titleBar: "LLM settings",
    intro:
      "These settings are stored server-side per shop (not in Liquid), so the API key is never exposed to the storefront.",
    saved: "Saved.",
    shopLabel: "Shop",
    providerLabel: "Provider",
    defaultModelLabel: "Default model",
    refreshModels: "Refresh models",
    refreshing: "Refreshing…",
    save: "Save",
    saving: "Saving…",
    errorsHeading: "Error",
    providers: {
      anthropic: "Claude (Anthropic)",
      openai: "OpenAI",
      gemini: "Gemini",
    },
    apiKeyLabels: {
      anthropic: "Anthropic API key",
      openai: "OpenAI API key",
      gemini: "Gemini API key",
    },
    apiKeyPlaceholderReplace: "Paste a new key to replace",
    apiKeyPlaceholderEnter: "Enter your key",
    apiKeySavedPrefix: "Saved:",
    encryptionKeyNotePrefix: "Requires",
    encryptionKeyNoteSuffix: "to be set on the server.",
    maxHistoryMessagesLabel: "Max history messages",
    maxHistoryMessagesHelp: "Maximum number of messages to send to LLM (default: 20, null = unlimited). Reduces costs for long conversations.",
  },
  fr: {
    titleBar: "Réglages LLM",
    intro:
      "Ces réglages sont enregistrés côté serveur par boutique (pas dans Liquid), donc la clé API n’est jamais exposée à la vitrine.",
    saved: "Enregistré.",
    shopLabel: "Boutique",
    providerLabel: "Fournisseur",
    defaultModelLabel: "Modèle par défaut",
    refreshModels: "Actualiser les modèles",
    refreshing: "Actualisation…",
    save: "Enregistrer",
    saving: "Enregistrement…",
    errorsHeading: "Erreur",
    providers: {
      anthropic: "Claude (Anthropic)",
      openai: "OpenAI",
      gemini: "Gemini",
    },
    apiKeyLabels: {
      anthropic: "Clé API Anthropic",
      openai: "Clé API OpenAI",
      gemini: "Clé API Gemini",
    },
    apiKeyPlaceholderReplace: "Collez une nouvelle clé pour remplacer",
    apiKeyPlaceholderEnter: "Saisissez votre clé",
    apiKeySavedPrefix: "Enregistré :",
    encryptionKeyNotePrefix: "Nécessite que",
    encryptionKeyNoteSuffix: "soit défini côté serveur.",
    maxHistoryMessagesLabel: "Nombre max de messages dans l'historique",
    maxHistoryMessagesHelp: "Nombre maximum de messages à envoyer au LLM (défaut: 20, null = illimité). Réduit les coûts pour les conversations longues.",
  },
};

function detectLocaleFromRequest(request) {
  const header = String(request?.headers?.get?.("Accept-Language") || "").toLowerCase();
  if (header.includes("fr")) return "fr";
  return "en";
}

function localizeErrorMessage(rawMessage, locale) {
  const msg = String(rawMessage || "").trim();
  if (!msg) return "";

  if (locale !== "fr") return msg;

  if (msg === "Missing shop") return "Boutique manquante.";
  if (msg === "Missing form") return "Formulaire manquant.";

  const saveFailed = msg.match(/^Save failed\s*\((\d+)\)\s*$/i);
  if (saveFailed) return `Échec de l’enregistrement (${saveFailed[1]})`;

  const refreshFailed = msg.match(/^Failed to refresh models\s*\((\d+)\)\s*$/i);
  if (refreshFailed) return `Impossible d’actualiser les modèles (${refreshFailed[1]})`;

  const noKey = msg.match(/^No (Anthropic|OpenAI|Gemini) API key configured\. Set it in Settings first\.\s*$/i);
  if (noKey) {
    const provider = String(noKey[1] || "").toLowerCase();
    const label =
      provider === "anthropic" ? "Anthropic" :
        provider === "openai" ? "OpenAI" : "Gemini";
    return `Aucune clé API ${label} n’est configurée. Renseignez-la d’abord dans Réglages.`;
  }

  const unsupported = msg.match(/^Unsupported provider:\s*(.+)\s*$/i);
  if (unsupported) return `Fournisseur non pris en charge : ${unsupported[1]}`;

  return msg;
}

function obfuscateKey(key) {
  const raw = typeof key === "string" ? key.trim() : "";
  if (!raw) return "";

  // Always use last 8 characters of the whole key (more robust than splitting on '-').
  const suffix = raw.length > 8 ? raw.slice(-8) : raw;
  if (raw.startsWith("sk-")) return `sk-.......-${suffix}`;
  const prefix = raw.slice(0, Math.min(3, raw.length));
  return `${prefix}.......${suffix}`;
}

export const loader = async ({ request }) => {
  const { authenticate } = await import("../shopify.server");
  const { getShopLlmSettings } = await import("../ai/shop-llm-settings.server");
  const { default: AppConfig } = await import("../config/app-config.server");

  const url = new URL(request.url);
  const saved = url.searchParams.get("saved") === "1";
  const error = url.searchParams.get("error") || "";
  const locale = detectLocaleFromRequest(request);

  const { session } = await authenticate.admin(request);
  const shop = session?.shop;

  const settings = shop ? await getShopLlmSettings(shop) : null;
  const provider = settings?.llmProvider || "anthropic";

  const anthropicKeyHint =
    (typeof settings?.anthropicApiKeyHint === "string" && settings.anthropicApiKeyHint)
      ? settings.anthropicApiKeyHint
      : (settings?.anthropicApiKey ? obfuscateKey(settings.anthropicApiKey) : "");
  const openaiKeyHint =
    (typeof settings?.openaiApiKeyHint === "string" && settings.openaiApiKeyHint)
      ? settings.openaiApiKeyHint
      : (settings?.openaiApiKey ? obfuscateKey(settings.openaiApiKey) : "");
  const geminiKeyHint =
    (typeof settings?.geminiApiKeyHint === "string" && settings.geminiApiKeyHint)
      ? settings.geminiApiKeyHint
      : (settings?.geminiApiKey ? obfuscateKey(settings.geminiApiKey) : "");

  const hasAnthropicKey = Boolean(settings?.hasAnthropicApiKey || settings?.anthropicApiKey);
  const hasOpenAiKey = Boolean(settings?.hasOpenAiApiKey || settings?.openaiApiKey);
  const hasGeminiKey = Boolean(settings?.hasGeminiApiKey || settings?.geminiApiKey);

  const configuredModel = (settings?.defaultModel && String(settings.defaultModel).trim().length > 0)
    ? String(settings.defaultModel).trim()
    : (AppConfig.api.defaultModels?.[provider] || AppConfig.api.defaultModel);

  const maxHistoryMessages = typeof settings?.maxHistoryMessages === "number" 
    ? settings.maxHistoryMessages 
    : (AppConfig.api.maxHistoryMessages || 20);

  return {
    shop,
    llmProvider: provider,
    defaultModel: configuredModel,
    maxHistoryMessages,
    defaultModels: AppConfig.api.defaultModels || {},
    hasAnthropicKey,
    anthropicKeyHint,
    hasOpenAiKey,
    openaiKeyHint,
    hasGeminiKey,
    geminiKeyHint,
    availableModels: Array.from(
      new Set([
        AppConfig.api.defaultModels?.[provider] || AppConfig.api.defaultModel,
        configuredModel
      ])
    ).filter(Boolean),
    saved,
    error,
    locale,
  };
};

export const action = async ({ request }) => {
  const { authenticate } = await import("../shopify.server");
  const { getShopLlmSettings, upsertShopLlmSettings } = await import("../ai/shop-llm-settings.server");

  const accept = request.headers.get("Accept") || "";
  const wantsJson =
    accept.includes("application/json") ||
    (request.headers.get("X-Requested-With") || "").toLowerCase() === "fetch";

  const { session } = await authenticate.admin(request);
  const shop = session?.shop;

  if (!shop) {
    if (wantsJson) {
      return new Response(JSON.stringify({ error: "Missing shop" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    return redirect("/app/settings?error=" + encodeURIComponent("Missing shop"));
  }

  const formData = await request.formData();

  const llmProvider = String(formData.get("llmProvider") || "anthropic");
  const defaultModel = String(formData.get("defaultModel") || "");
  const maxHistoryMessagesRaw = formData.get("maxHistoryMessages");
  const maxHistoryMessages = maxHistoryMessagesRaw ? parseInt(String(maxHistoryMessagesRaw), 10) : null;
  const anthropicApiKey = String(formData.get("anthropicApiKey") || "");
  const openaiApiKey = String(formData.get("openaiApiKey") || "");
  const geminiApiKey = String(formData.get("geminiApiKey") || "");

  try {
    await upsertShopLlmSettings({
      shop,
      llmProvider,
      defaultModel,
      maxHistoryMessages: (maxHistoryMessages && maxHistoryMessages > 0) ? maxHistoryMessages : null,
      anthropicApiKey,
      openaiApiKey,
      geminiApiKey,
    });

    if (wantsJson) {
      // Return updated hint so UI can show it immediately without reload.
      const updated = await getShopLlmSettings(shop);
      const hintAnthropic = (updated?.anthropicApiKeyHint || (updated?.anthropicApiKey ? obfuscateKey(updated.anthropicApiKey) : "") || (anthropicApiKey ? obfuscateKey(anthropicApiKey) : "")).trim?.() || "";
      const hintOpenAi = (updated?.openaiApiKeyHint || (updated?.openaiApiKey ? obfuscateKey(updated.openaiApiKey) : "") || (openaiApiKey ? obfuscateKey(openaiApiKey) : "")).trim?.() || "";
      const hintGemini = (updated?.geminiApiKeyHint || (updated?.geminiApiKey ? obfuscateKey(updated.geminiApiKey) : "") || (geminiApiKey ? obfuscateKey(geminiApiKey) : "")).trim?.() || "";

      const hasAnth = Boolean(updated?.hasAnthropicApiKey || updated?.anthropicApiKey || anthropicApiKey);
      const hasOai = Boolean(updated?.hasOpenAiApiKey || updated?.openaiApiKey || openaiApiKey);
      const hasGem = Boolean(updated?.hasGeminiApiKey || updated?.geminiApiKey || geminiApiKey);

      return new Response(JSON.stringify({
        ok: true,
        hasAnthropicKey: hasAnth,
        anthropicKeyHint: hintAnthropic,
        hasOpenAiKey: hasOai,
        openaiKeyHint: hintOpenAi,
        hasGeminiKey: hasGem,
        geminiKeyHint: hintGemini,
      }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    return redirect("/app/settings?saved=1");
  } catch (e) {
    const message = e?.message || String(e);
    if (wantsJson) {
      return new Response(JSON.stringify({ error: message }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    return redirect("/app/settings?error=" + encodeURIComponent(message));
  }
};

export default function SettingsPage() {
  const data = useLoaderData();
  const locale = (data?.locale && I18N[data.locale]) ? data.locale : "fr";
  const t = I18N[locale];

  const initialModels = useMemo(() => {
    const list = Array.isArray(data.availableModels) ? data.availableModels : [];
    return list.map((id) => ({ id, display_name: id }));
  }, [data.availableModels]);

  const formRef = useRef(null);
  const [provider, setProvider] = useState(String(data.llmProvider || "anthropic"));
  const [models, setModels] = useState(initialModels);
  const [selectedModel, setSelectedModel] = useState(String(data.defaultModel || ""));
  const [maxHistoryMessages, setMaxHistoryMessages] = useState(String(data.maxHistoryMessages || "20"));
  const [modelsError, setModelsError] = useState("");
  const [refreshingModels, setRefreshingModels] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveOk, setSaveOk] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [hasAnthropicKey, setHasAnthropicKey] = useState(Boolean(data.hasAnthropicKey));
  const [anthropicKeyHint, setAnthropicKeyHint] = useState(String(data.anthropicKeyHint || ""));
  const [hasOpenAiKey, setHasOpenAiKey] = useState(Boolean(data.hasOpenAiKey));
  const [openaiKeyHint, setOpenaiKeyHint] = useState(String(data.openaiKeyHint || ""));
  const [hasGeminiKey, setHasGeminiKey] = useState(Boolean(data.hasGeminiKey));
  const [geminiKeyHint, setGeminiKeyHint] = useState(String(data.geminiKeyHint || ""));

  const refreshModels = async () => {
    try {
      setRefreshingModels(true);
      setModelsError("");
      const search = (typeof window !== "undefined" && typeof window.location?.search === "string")
        ? window.location.search
        : "";
      const sep = search && search.includes("?") ? "&" : "?";
      const res = await fetch(
        `/app/models${search}${sep}provider=${encodeURIComponent(provider || "anthropic")}&selectedModel=${encodeURIComponent(selectedModel || "")}`,
        {
        method: "GET",
        headers: { "Accept": "application/json" },
        credentials: "same-origin",
        }
      );
      const json = await res.json();
      if (!res.ok) {
        setModelsError(localizeErrorMessage(json?.error || `Failed to refresh models (${res.status})`, locale));
        // Avoid showing stale models from a different provider when refresh fails.
        const fallback = (data.defaultModels && data.defaultModels[provider]) ? data.defaultModels[provider] : "";
        if (fallback) {
          setModels([{ id: fallback, display_name: fallback }]);
          setSelectedModel(fallback);
        }
        return;
      }
      if (Array.isArray(json?.models)) {
        setModels(json.models);
        if (!json.models.some((m) => m?.id === selectedModel)) {
          const first = json.models[0]?.id;
          if (first) setSelectedModel(first);
        }
      }
    } catch (e) {
      setModelsError(localizeErrorMessage(e?.message || String(e), locale));
    } finally {
      setRefreshingModels(false);
    }
  };

  const onSave = async (event) => {
    event.preventDefault();
    setSaving(true);
    setSaveOk(false);
    setSaveError("");

    try {
      const form = formRef.current;
      if (!form) throw new Error("Missing form");

      const fd = new FormData(form);
      // IMPORTANT: include the current embedded app query (?shop=...&host=...) so authenticate.admin can resolve the shop.
      const actionUrl = (typeof window !== "undefined" && window.location)
        ? `${window.location.pathname}${window.location.search || ""}`
        : "/app/settings";

      const res = await fetch(actionUrl, {
        method: "POST",
        body: fd,
        headers: {
          Accept: "application/json",
          "X-Requested-With": "fetch",
        },
        credentials: "same-origin",
      });

      const rawText = await res.text().catch(() => "");
      const json = (() => { try { return rawText ? JSON.parse(rawText) : {}; } catch { return {}; } })();
      if (!res.ok) throw new Error(json?.error || rawText || `Save failed (${res.status})`);

      setSaveOk(true);
      // Update UI immediately (no refresh needed)
      const submittedAnth = String(fd.get("anthropicApiKey") || "").trim();
      const submittedOai = String(fd.get("openaiApiKey") || "").trim();
      const submittedGem = String(fd.get("geminiApiKey") || "").trim();

      if (typeof json?.hasAnthropicKey === "boolean") setHasAnthropicKey(json.hasAnthropicKey);
      else if (submittedAnth) setHasAnthropicKey(true);
      if (typeof json?.anthropicKeyHint === "string" && json.anthropicKeyHint.trim()) setAnthropicKeyHint(json.anthropicKeyHint.trim());
      else if (submittedAnth) setAnthropicKeyHint(obfuscateKey(submittedAnth));

      if (typeof json?.hasOpenAiKey === "boolean") setHasOpenAiKey(json.hasOpenAiKey);
      else if (submittedOai) setHasOpenAiKey(true);
      if (typeof json?.openaiKeyHint === "string" && json.openaiKeyHint.trim()) setOpenaiKeyHint(json.openaiKeyHint.trim());
      else if (submittedOai) setOpenaiKeyHint(obfuscateKey(submittedOai));

      if (typeof json?.hasGeminiKey === "boolean") setHasGeminiKey(json.hasGeminiKey);
      else if (submittedGem) setHasGeminiKey(true);
      if (typeof json?.geminiKeyHint === "string" && json.geminiKeyHint.trim()) setGeminiKeyHint(json.geminiKeyHint.trim());
      else if (submittedGem) setGeminiKeyHint(obfuscateKey(submittedGem));

      // Clear the key field so we don't keep it in the DOM after saving.
      try {
        const inputs = [
          'input[name="anthropicApiKey"]',
          'input[name="openaiApiKey"]',
          'input[name="geminiApiKey"]',
        ];
        inputs.forEach((sel) => {
          const el = form.querySelector(sel);
          if (el) el.value = "";
        });
      } catch {
        // ignore
      }
    } catch (e) {
      setSaveError(localizeErrorMessage(e?.message || String(e), locale));
    } finally {
      setSaving(false);
    }
  };

  const displaySaveError = localizeErrorMessage(saveError || data.error, locale);

  return (
    <s-page>
      <ui-title-bar title={t.titleBar} />

      <s-section>
        <s-stack gap="base">
          <s-paragraph>{t.intro}</s-paragraph>

          {saveOk || data.saved ? (
            <s-paragraph tone="success">
              {t.saved}
            </s-paragraph>
          ) : null}

          {displaySaveError ? (
            <s-paragraph tone="critical">
              {displaySaveError}
            </s-paragraph>
          ) : null}

          {modelsError ? (
            <s-paragraph tone="critical">
              {modelsError}
            </s-paragraph>
          ) : null}

          <s-paragraph>
            <s-text>{t.shopLabel}: </s-text>
            <s-text>{data.shop}</s-text>
          </s-paragraph>

          <form ref={formRef} method="post" onSubmit={onSave} style={{ display: "grid", gap: 12, maxWidth: 520 }}>
            <label>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>{t.providerLabel}</div>
              <select
                name="llmProvider"
                value={provider}
                onChange={(e) => {
                  const next = e.target.value;
                  setProvider(next);
                  setModelsError("");
                  // Reset models list to a provider-specific default until refreshed.
                  const fallback = (data.defaultModels && data.defaultModels[next]) ? data.defaultModels[next] : "";
                  if (fallback) {
                    setModels([{ id: fallback, display_name: fallback }]);
                    setSelectedModel(fallback);
                  } else {
                    setModels([]);
                    setSelectedModel("");
                  }
                }}
                style={{ width: "100%", padding: 8 }}
              >
                <option value="anthropic">{t.providers.anthropic}</option>
                <option value="openai">{t.providers.openai}</option>
                <option value="gemini">{t.providers.gemini}</option>
              </select>
            </label>

            <label>
              <div style={{ fontWeight: 600, marginBottom: 6, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <span>{t.defaultModelLabel}</span>
                <button
                  type="button"
                  onClick={refreshModels}
                  style={{ padding: "6px 10px" }}
                >
                  {refreshingModels ? t.refreshing : t.refreshModels}
                </button>
              </div>
              <select
                name="defaultModel"
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
                style={{ width: "100%", padding: 8 }}
              >
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.display_name || m.id}
                  </option>
                ))}
              </select>
            </label>

            <label>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>{t.maxHistoryMessagesLabel}</div>
              <input
                name="maxHistoryMessages"
                type="number"
                min="1"
                value={maxHistoryMessages}
                onChange={(e) => setMaxHistoryMessages(e.target.value)}
                placeholder="20"
                style={{ width: "100%", padding: 8 }}
              />
              <div style={{ fontSize: 12, opacity: 0.8, marginTop: 6 }}>
                {t.maxHistoryMessagesHelp}
              </div>
            </label>

            {provider === "anthropic" ? (
              <label>
                <div style={{ fontWeight: 600, marginBottom: 6 }}>{t.apiKeyLabels.anthropic}</div>
                <input
                  name="anthropicApiKey"
                  type="text"
                  defaultValue=""
                  placeholder={hasAnthropicKey ? t.apiKeyPlaceholderReplace : t.apiKeyPlaceholderEnter}
                  autoComplete="off"
                  spellCheck={false}
                  style={{ width: "100%", padding: 8 }}
                />
                {hasAnthropicKey ? (
                  <div style={{ fontSize: 12, marginTop: 6, color: "var(--p-color-text-success, #15803d)" }}>
                    {t.apiKeySavedPrefix} {anthropicKeyHint || "sk-.......-********"}
                  </div>
                ) : null}
                <div style={{ fontSize: 12, opacity: 0.8, marginTop: 6 }}>
                  {t.encryptionKeyNotePrefix} <code>APP_SETTINGS_ENCRYPTION_KEY</code> {t.encryptionKeyNoteSuffix}
                </div>
              </label>
            ) : null}

            {provider === "openai" ? (
              <label>
                <div style={{ fontWeight: 600, marginBottom: 6 }}>{t.apiKeyLabels.openai}</div>
                <input
                  name="openaiApiKey"
                  type="text"
                  defaultValue=""
                  placeholder={hasOpenAiKey ? t.apiKeyPlaceholderReplace : t.apiKeyPlaceholderEnter}
                  autoComplete="off"
                  spellCheck={false}
                  style={{ width: "100%", padding: 8 }}
                />
                {hasOpenAiKey ? (
                  <div style={{ fontSize: 12, marginTop: 6, color: "var(--p-color-text-success, #15803d)" }}>
                    {t.apiKeySavedPrefix} {openaiKeyHint || "sk-.......-********"}
                  </div>
                ) : null}
                <div style={{ fontSize: 12, opacity: 0.8, marginTop: 6 }}>
                  {t.encryptionKeyNotePrefix} <code>APP_SETTINGS_ENCRYPTION_KEY</code> {t.encryptionKeyNoteSuffix}
                </div>
              </label>
            ) : null}

            {provider === "gemini" ? (
              <label>
                <div style={{ fontWeight: 600, marginBottom: 6 }}>{t.apiKeyLabels.gemini}</div>
                <input
                  name="geminiApiKey"
                  type="text"
                  defaultValue=""
                  placeholder={hasGeminiKey ? t.apiKeyPlaceholderReplace : t.apiKeyPlaceholderEnter}
                  autoComplete="off"
                  spellCheck={false}
                  style={{ width: "100%", padding: 8 }}
                />
                {hasGeminiKey ? (
                  <div style={{ fontSize: 12, marginTop: 6, color: "var(--p-color-text-success, #15803d)" }}>
                    {t.apiKeySavedPrefix} {geminiKeyHint || "AIza.......********"}
                  </div>
                ) : null}
                <div style={{ fontSize: 12, opacity: 0.8, marginTop: 6 }}>
                  {t.encryptionKeyNotePrefix} <code>APP_SETTINGS_ENCRYPTION_KEY</code> {t.encryptionKeyNoteSuffix}
                </div>
              </label>
            ) : null}

            <button type="submit" style={{ padding: "10px 12px", fontWeight: 600 }} disabled={saving}>
              {saving ? t.saving : t.save}
            </button>
          </form>
        </s-stack>
      </s-section>
    </s-page>
  );
}

