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

function matchesAllAdjectives(product, adjectives) {
  const adjs = Array.isArray(adjectives) ? adjectives.filter(Boolean) : [];
  if (adjs.length === 0) return true;

  const hay = `${product?.title || ""} ${product?.description || ""}`.toLowerCase();
  return adjs.every((adj) => hay.includes(String(adj).toLowerCase()));
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
    const analysis = await analyzeCustomerProductRequest(state.textForAnalysis);
    return { analysis };
  });

  graph.addNode("search_by_name", async (state) => {
    const analysis = Array.isArray(state.analysis) ? state.analysis : [];
    if (!Array.isArray(mcpClient?.tools) || !mcpClient.tools.some((t) => t?.name === productSearchToolName)) {
      return { nameSearchResults: [] };
    }

    const all = [];
    for (const item of analysis) {
      const productName = normalizeText(item?.product);
      if (!productName) continue;

      const resp = await mcpClient.callTool(productSearchToolName, {
        query: productName,
        context: "Customer is searching for products. Use the query to find relevant items.",
      });
      if (resp?.error) continue;

      const products = toolService.processProductSearchResult(resp);
      if (Array.isArray(products) && products.length > 0) all.push(...products);
    }

    return { nameSearchResults: uniqById(all) };
  });

  graph.addNode("refine_within_results", async (state) => {
    const analysis = Array.isArray(state.analysis) ? state.analysis : [];
    const results = Array.isArray(state.nameSearchResults) ? state.nameSearchResults : [];
    if (analysis.length === 0 || results.length === 0) return { refinedProducts: results };

    // Union of adjectives across extracted products (as required: only descriptors explicitly present)
    const adjectives = Array.from(
      new Set(
        analysis
          .flatMap((it) => (Array.isArray(it?.adjectives) ? it.adjectives : []))
          .map((x) => String(x))
          .filter(Boolean)
      )
    );

    const filtered = results.filter((p) => matchesAllAdjectives(p, adjectives));
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
      const out = await app.invoke({ textForAnalysis });
      return {
        analysis: Array.isArray(out?.analysis) ? out.analysis : [],
        products: Array.isArray(out?.refinedProducts) ? out.refinedProducts : [],
      };
    },
  };
}

export default {
  createProductRequestWorkflow,
};

