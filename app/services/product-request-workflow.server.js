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
import AppConfig from "./config.server";
import { analyzeCustomerProductRequest } from "./product-request-analyzer.server";

const PRODUCT_WORKFLOW_DEBUG =
  process.env.PRODUCT_WORKFLOW_DEBUG === "1" ||
  process.env.PRODUCT_WORKFLOW_DEBUG === "true";

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

  const hay = `${product?.title || ""} ${product?.description || ""}`.toLowerCase();
  return chars.every((c) => hay.includes(String(c).toLowerCase()));
}

/**
 * Creates a LangGraph workflow instance.
 *
 * @param {Object} deps
 * @param {import("../mcp-client").default} deps.mcpClient
 * @param {ReturnType<import("./tool.server").createToolService>} deps.toolService
 * @param {string} deps.productSearchToolName
 * @returns {{ run: (params: { textForAnalysis: string }) => Promise<{ analysis: any[], products: any[] }> }}
 */
export function createProductRequestWorkflow({
  mcpClient,
  toolService,
  productSearchToolName = AppConfig.tools.productSearchName,
}) {
  const graph = new StateGraph({
    channels: {
      textForAnalysis: { value: "" },
      analysis: { value: [] },
      nameSearchResults: { value: [] }, // flattened products
      refinedProducts: { value: [] },
    },
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
      Array.isArray(mcpClient?.tools) &&
      mcpClient.tools.some((t) => t?.name === productSearchToolName);

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
          availableTools: Array.isArray(mcpClient?.tools) ? mcpClient.tools.map((t) => t?.name).filter(Boolean) : [],
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
        context: "Customer is searching for products. Use the query to find relevant items.",
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
    "analyze",
    (state) => (Array.isArray(state.analysis) && state.analysis.length > 0 ? "HAS_PRODUCTS" : "NO_PRODUCTS"),
    {
      HAS_PRODUCTS: "search_by_name",
      NO_PRODUCTS: END,
    }
  );

  graph.addEdge("search_by_name", "refine_within_results");
  graph.addEdge("refine_within_results", END);
  graph.setEntryPoint("analyze");

  const app = graph.compile();

  return {
    async run({ textForAnalysis }) {
      debugLog("run:start", { textForAnalysis });
      const out = await app.invoke({ textForAnalysis });
      const result = {
        analysis: Array.isArray(out?.analysis) ? out.analysis : [],
        products: Array.isArray(out?.refinedProducts) ? out.refinedProducts : [],
      };
      debugLog("run:end", { analysisLen: result.analysis.length, productsLen: result.products.length });
      return result;
    },
  };
}

export default {
  createProductRequestWorkflow,
};

