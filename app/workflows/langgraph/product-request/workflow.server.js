/**
 * Product Request Workflow
 *
 * Required behavior:
 * - Analyze product requests BEFORE calling the main model
 * - Two-step search:
 *   1) search by product name
 *   2) refine by characteristics ONLY within results of (1)
 *
 * Implemented with LangGraph so it can evolve into richer flows.
 */
import { END, StateGraph } from "@langchain/langgraph";
import AppConfig from "../../../config/app-config.server";
import {
  analyzeCustomerProductRequest,
  classifyCustomerMessageIntent,
  isExplicitRecipePrompt,
} from "./analyzer.server";

const PRODUCT_WORKFLOW_DEBUG =
  process.env.PRODUCT_WORKFLOW_DEBUG === "1" || process.env.PRODUCT_WORKFLOW_DEBUG === "true";

function debugLog(...args) {
  if (!PRODUCT_WORKFLOW_DEBUG) return;
  console.log("[product-workflow][graph]", ...args);
}

function infoLog(...args) {
  console.log("[product-workflow][graph]", ...args);
}

function normalizeText(s) {
  return (s || "").toString().trim();
}

function stripDiacritics(s) {
  try {
    return String(s || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
  } catch {
    return String(s || "");
  }
}

function safeJsonParseFromModelText(text) {
  const raw = normalizeText(text);
  if (!raw) return null;

  // Prefer the first JSON object in the text.
  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return null;

  const candidate = raw.slice(firstBrace, lastBrace + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

function normalizeForMatch(s) {
  return stripDiacritics(String(s || ""))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseRecipeSelectionFromUserMessage(userMessage, recipeState) {
  const msg = normalizeText(userMessage);
  const items = Array.isArray(recipeState?.items) ? recipeState.items : [];
  if (!msg || items.length === 0) return [];

  const lower = normalizeForMatch(msg);

  // Shortcut keywords
  if (/\b(tout|tous|toute|toutes)\b/i.test(lower))
    return items.map((x) => x?.label).filter(Boolean);
  if (/\b(aucun|aucune|rien)\b/i.test(lower)) return [];

  // 1) Parse explicit numeric selections like "1, 3 et 5"
  const pickedByNumber = new Set();
  for (const m of msg.matchAll(/\b(\d{1,2})\b/g)) {
    const n = Number(m[1]);
    if (!Number.isFinite(n)) continue;
    if (n >= 1 && n <= items.length) pickedByNumber.add(n - 1);
  }
  if (pickedByNumber.size > 0) {
    return Array.from(pickedByNumber)
      .map((idx) => items[idx]?.label)
      .filter(Boolean);
  }

  // 2) Parse by matching item labels in free-form text
  const picked = [];
  for (const it of items) {
    const label = normalizeText(it?.label);
    if (!label) continue;
    const normLabel = normalizeForMatch(label);
    if (!normLabel) continue;
    if (lower.includes(normLabel)) picked.push(label);
  }

  // 3) If user pasted checklist lines, try extracting after "- [x]" or "- [ ]"
  if (picked.length === 0) {
    const lines = msg
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    for (const line of lines) {
      const m = line.match(/^\s*-\s*\[[ xX]\]\s*(.+)\s*$/);
      if (m && m[1]) picked.push(m[1].trim());
    }
  }

  // Deduplicate while preserving order
  const seen = new Set();
  return picked.filter((x) => {
    const k = normalizeForMatch(x);
    if (!k) return false;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function uniqById(products) {
  const out = [];
  const seen = new Set();
  for (const p of Array.isArray(products) ? products : []) {
    const key = p?.id || JSON.stringify(p);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

function matchesAllCharacteristics(product, characteristics) {
  const chars = Array.isArray(characteristics) ? characteristics.filter(Boolean) : [];
  if (chars.length === 0) return true;

  // Normalize for robust matching:
  // - remove diacritics (gâteau -> gateau)
  // - collapse whitespace/punctuation
  const hay = normalizeForMatch(`${product?.title || ""} ${product?.description || ""}`);

  const variantsFor = (c) => {
    const raw = String(c || "").trim();
    if (!raw) return [];
    const out = new Set([raw]);
    // If characteristic is like "à X" / "a X", also match "X"
    const m = raw.match(/^(?:à|a)\s+(.+)$/i);
    if (m && m[1]) out.add(m[1].trim());
    return Array.from(out)
      .map((x) => normalizeForMatch(x))
      .filter(Boolean);
  };

  // First attempt: require all characteristics to match.
  const strictOk = chars.every((c) => {
    const variants = variantsFor(c);
    if (variants.length === 0) return true;
    return variants.some((v) => hay.includes(v));
  });
  if (strictOk) return true;

  // Second attempt (softer): match at least one characteristic.
  // This avoids returning unrelated cards when strict matching is too literal.
  return chars.some((c) => {
    const variants = variantsFor(c);
    if (variants.length === 0) return false;
    return variants.some((v) => hay.includes(v));
  });
}

/**
 * Creates a LangGraph workflow instance.
 *
 * @param {Object} deps
 * @param {import("../../../mcp/client.server").default} deps.mcpClient
 * @param {ReturnType<import("../../../tools/tool-service.server").createToolService>} deps.toolService
 * @param {string} deps.productSearchToolName
 * @param {{ streamConversation: Function }} deps.llmService
 * @param {string} [deps.recipePromptType]
 * @returns {{
 *   run: (params: {
 *     userMessage: string,
 *     textForAnalysis: string,
 *     pendingRecipeState: any
 *   }) => Promise<
 *     | { kind: 'recipe_checklist', assistantText: string, recipeStateUpdate: any, analysis: any[], products: any[] }
 *     | { kind: 'product_results', recipeStateUpdate?: any, analysis: any[], products: any[] }
 *     | { kind: 'none', recipeStateUpdate?: any, analysis: any[], products: any[] }
 *   >
 * }}
 */
export function createProductRequestWorkflow({
  mcpClient,
  toolService,
  productSearchToolName = AppConfig.tools.productSearchName,
  llmService,
  recipePromptType = "recipeExtractor",
}) {
  const graph = new StateGraph({
    channels: {
      userMessage: { value: "" },
      textForAnalysis: { value: "" },
      pendingRecipeState: { value: null }, // { status:'pending', items:[{label:string}] }
      recipeStateUpdate: { value: null }, // { status:'pending'|'done', ... }
      assistantText: { value: "" }, // when workflow wants to directly answer (recipe branch)
      recipeChecklist: { value: null }, // { items: string[], summary?: string }
      intentRoute: { value: "" },
      analysis: { value: [] },
      nameSearchResults: { value: [] }, // flattened products
      refinedProducts: { value: [] },
    },
  });

  graph.addNode("route", async (state) => {
    const msg = normalizeText(state.userMessage);
    const pending = state.pendingRecipeState;
    const hasPending =
      pending &&
      typeof pending === "object" &&
      pending.status === "pending" &&
      Array.isArray(pending.items) &&
      pending.items.length > 0;

    if (hasPending && msg) {
      // If the user explicitly asks for a recipe again, restart recipe flow.
      if (isExplicitRecipePrompt(msg)) return { intentRoute: "RECIPE_START" };

      // If the user is selecting from the checklist, go to selection.
      const selected = parseRecipeSelectionFromUserMessage(msg, pending);
      const isSelectAllOrNone = /\b(tout|tous|toute|toutes|aucun|aucune|rien)\b/i.test(
        stripDiacritics(msg.toLowerCase())
      );
      if (selected.length > 0 || isSelectAllOrNone) return { intentRoute: "RECIPE_SELECTION" };

      // Otherwise, route based on shared classifier and clear pending state to avoid loops.
      const classifiedPending = classifyCustomerMessageIntent(msg);
      debugLog("node:route:classified_pending", { msg, classifiedPending });
      if (classifiedPending.kind === "recipe") return { intentRoute: "RECIPE_START" };
      return {
        intentRoute: classifiedPending.kind === "product" ? "PRODUCT" : "OTHER",
        recipeStateUpdate: {
          status: "done",
          completedAt: Date.now(),
          reason: "abandoned_by_new_request",
        },
      };
    }

    const classified = classifyCustomerMessageIntent(msg);
    debugLog("node:route:classified", { msg, classified });

    if (classified.kind === "recipe") return { intentRoute: "RECIPE_START" };
    if (classified.kind === "product") return { intentRoute: "PRODUCT" };
    return { intentRoute: "OTHER" };
  });

  graph.addNode("extract_recipe", async (state) => {
    const msg = normalizeText(state.userMessage);
    if (!msg || !llmService) return { assistantText: "", recipeStateUpdate: null };

    // Use a dedicated prompt that outputs strict JSON in French.
    let buffer = "";
    const final = await llmService.streamConversation(
      {
        messages: [{ role: "user", content: msg }],
        promptType: recipePromptType,
        tools: [],
      },
      {
        onText: (delta) => {
          buffer += delta || "";
        },
      }
    );

    // Fallback if for any reason we didn't capture deltas
    if (!buffer) {
      const blocks = Array.isArray(final?.content) ? final.content : [];
      buffer = blocks
        .map((b) => (b && b.type === "text" && typeof b.text === "string" ? b.text : ""))
        .join("\n")
        .trim();
    }

    const parsed = safeJsonParseFromModelText(buffer) || {};
    const summary = normalizeText(parsed?.summary);
    const items = Array.isArray(parsed?.items)
      ? parsed.items.map((x) => normalizeText(x)).filter(Boolean)
      : [];

    const deduped = Array.from(new Set(items)).slice(0, 25);

    // Keep the assistant message short; the UI will render the interactive checklist widget.
    const assistantText = [
      `### Résumé`,
      summary || `Je peux t’aider à préparer la liste du matériel pour cette recette.`,
      ``,
      `Je t’affiche une liste d’**ustensiles / appareils** juste en dessous : coche ce qu’il te manque, puis lance la recherche.`,
      ``,
      // Fallback for clients that haven't loaded the widget yet (or are cached):
      `### Ustensiles / appareils`,
      ...(deduped.length > 0 ? deduped.map((it) => `- ${it}`) : [`- (aucun élément détecté)`]),
    ].join("\n");

    return {
      assistantText,
      recipeChecklist: { summary, items: deduped },
      recipeStateUpdate: {
        status: "pending",
        summary,
        items: deduped.map((label) => ({ label })),
        createdAt: Date.now(),
      },
    };
  });

  graph.addNode("select_from_recipe", async (state) => {
    const pending = state.pendingRecipeState;
    const selected = parseRecipeSelectionFromUserMessage(state.userMessage, pending);

    // Mark recipe selection as handled (even if empty), so we don't stay stuck in "pending".
    const recipeStateUpdate = { status: "done", completedAt: Date.now() };

    if (!Array.isArray(selected) || selected.length === 0) {
      return { textForAnalysis: "", recipeStateUpdate };
    }

    // Build a French shopping intent sentence so the deterministic analyzer reliably triggers.
    const textForAnalysis = `Je cherche ${selected.join(", ")}.`;
    return { textForAnalysis, recipeStateUpdate };
  });

  graph.addNode("analyze", async (state) => {
    debugLog("node:analyze:start", { textForAnalysis: state.textForAnalysis });
    const analysis = await analyzeCustomerProductRequest(state.textForAnalysis);
    debugLog("node:analyze:end", { analysisLen: analysis.length, analysis });
    return { analysis };
  });

  graph.addNode("search_by_name", async (state) => {
    const analysis = Array.isArray(state.analysis) ? state.analysis : [];
    const hasTool =
      Array.isArray(mcpClient?.tools) && mcpClient.tools.some((t) => t?.name === productSearchToolName);

    debugLog("node:search_by_name:start", {
      productSearchToolName,
      hasTool,
      analysisLen: analysis.length,
    });

    if (!hasTool) {
      debugLog("node:search_by_name:skip", "missing_tool");
      if (analysis.length > 0) {
        infoLog("missing_catalog_search_tool", {
          productSearchToolName,
          availableTools: Array.isArray(mcpClient?.tools)
            ? mcpClient.tools.map((t) => t?.name).filter(Boolean)
            : [],
        });
      }
      return { nameSearchResults: [] };
    }

    const all = [];
    for (const item of analysis) {
      const productName = normalizeText(item?.product);
      if (!productName) continue;

      debugLog("node:search_by_name:call_tool", { query: productName });
      const resp = await mcpClient.callTool(productSearchToolName, {
        query: productName,
        context: "Le client cherche des produits. Utilisez la requête pour trouver des articles pertinents.",
      });
      if (resp?.error) {
        debugLog("node:search_by_name:tool_error", { query: productName, error: resp.error });
        infoLog("catalog_search_tool_error", { query: productName, errorType: resp?.error?.type });
        continue;
      }

      const products = toolService.processProductSearchResult(resp);
      debugLog("node:search_by_name:tool_ok", { query: productName, productsLen: products?.length || 0 });
      if (Array.isArray(products) && products.length > 0) all.push(...products);
    }

    const nameSearchResults = uniqById(all);
    debugLog("node:search_by_name:end", { nameSearchResultsLen: nameSearchResults.length });
    return { nameSearchResults };
  });

  graph.addNode("refine_within_results", async (state) => {
    const analysis = Array.isArray(state.analysis) ? state.analysis : [];
    const results = Array.isArray(state.nameSearchResults) ? state.nameSearchResults : [];
    if (analysis.length === 0 || results.length === 0) return { refinedProducts: results };

    // Union of characteristics across extracted products (as required: only descriptors explicitly present)
    const characteristics = Array.from(
      new Set(
        analysis
          .flatMap((it) => (Array.isArray(it?.characteristics) ? it.characteristics : []))
          .map((x) => String(x))
          .filter(Boolean)
      )
    );

    const filtered = results.filter((p) => matchesAllCharacteristics(p, characteristics));
    debugLog("node:refine_within_results", {
      characteristics,
      inputResultsLen: results.length,
      filteredLen: filtered.length,
      usedFallbackToResults: filtered.length === 0,
    });
    return { refinedProducts: filtered.length > 0 ? filtered : results };
  });

  graph.addConditionalEdges(
    "route",
    (state) => state.intentRoute || "PRODUCT",
    {
      RECIPE_START: "extract_recipe",
      RECIPE_SELECTION: "select_from_recipe",
      PRODUCT: "analyze",
      OTHER: END,
    }
  );

  graph.addConditionalEdges(
    "analyze",
    (state) => (Array.isArray(state.analysis) && state.analysis.length > 0 ? "HAS_PRODUCTS" : "NO_PRODUCTS"),
    {
      HAS_PRODUCTS: "search_by_name",
      NO_PRODUCTS: END,
    }
  );

  graph.addEdge("search_by_name", "refine_within_results");
  graph.addEdge("refine_within_results", END);
  graph.addEdge("extract_recipe", END);
  graph.addEdge("select_from_recipe", "analyze");

  graph.setEntryPoint("route");

  const app = graph.compile();

  return {
    async run({ userMessage, textForAnalysis, pendingRecipeState }) {
      debugLog("run:start", { userMessage, textForAnalysis, hasPendingRecipeState: !!pendingRecipeState });
      const out = await app.invoke({ userMessage, textForAnalysis, pendingRecipeState });

      const assistantText = normalizeText(out?.assistantText);
      const recipeChecklist = out?.recipeChecklist || null;
      const recipeStateUpdate = out?.recipeStateUpdate || null;
      const analysis = Array.isArray(out?.analysis) ? out.analysis : [];
      const products = Array.isArray(out?.refinedProducts) ? out.refinedProducts : [];

      if (assistantText) {
        debugLog("run:end:recipe", { assistantTextLen: assistantText.length });
        return {
          kind: "recipe_checklist",
          assistantText,
          recipeChecklist,
          recipeStateUpdate,
          analysis: [],
          products: [],
        };
      }

      if (!analysis || analysis.length === 0) {
        debugLog("run:end:none", { analysisLen: 0 });
        return { kind: "none", analysis: [], products: [], recipeStateUpdate };
      }

      debugLog("run:end:products", { analysisLen: analysis.length, productsLen: products.length });
      return { kind: "product_results", analysis, products, recipeStateUpdate };
    },
  };
}

export default {
  createProductRequestWorkflow,
};
