/**
 * Tool Service
 * Manages tool execution and processing
 */
import { saveMessage } from "../db.server";
import AppConfig from "../config/app-config.server";

/**
 * Creates a tool service instance
 * @returns {Object} Tool service with methods for managing tools
 */
export function createToolService() {
  const tryParseJsonFromText = (text) => {
    try {
      if (typeof text !== "string") return null;
      const raw = text.trim();
      if (!raw) return null;

      // Direct parse
      try {
        return JSON.parse(raw);
      } catch {
        // continue
      }

      // Best-effort: parse first JSON object/array embedded in text
      const firstObj = raw.indexOf("{");
      const lastObj = raw.lastIndexOf("}");
      if (firstObj !== -1 && lastObj !== -1 && lastObj > firstObj) {
        const candidate = raw.slice(firstObj, lastObj + 1);
        try {
          return JSON.parse(candidate);
        } catch {
          // continue
        }
      }

      const firstArr = raw.indexOf("[");
      const lastArr = raw.lastIndexOf("]");
      if (firstArr !== -1 && lastArr !== -1 && lastArr > firstArr) {
        const candidate = raw.slice(firstArr, lastArr + 1);
        try {
          return JSON.parse(candidate);
        } catch {
          // continue
        }
      }

      return null;
    } catch {
      return null;
    }
  };

  /**
   * Best-effort parser for MCP tool responses.
   * MCP tool content is commonly shaped like: [{ type: "text", text: "{...json...}" }]
   * but can vary, so we scan and try to parse.
   * @param {any} toolUseResponse
   * @returns {any|null}
   */
  const parseToolResponseData = (toolUseResponse) => {
    try {
      const content = toolUseResponse?.content;
      // Some MCP servers return structured JSON directly at the top-level of `result`
      // (e.g. { product: {...} } or { products: [...] }) instead of a `content` array.
      // In that case, treat the response itself as already-parsed data.
      if (!content) {
        if (toolUseResponse && typeof toolUseResponse === "object" && !Array.isArray(toolUseResponse)) {
          const hasKnownShape =
            Array.isArray(toolUseResponse.products) ||
            (toolUseResponse.product && typeof toolUseResponse.product === "object") ||
            (toolUseResponse.data && typeof toolUseResponse.data === "object");
          if (hasKnownShape) return toolUseResponse;
        }
        return null;
      }

      // If it's already an object (not an array), treat it as parsed.
      if (typeof content === "object" && !Array.isArray(content)) return content;

      const blocks = Array.isArray(content) ? content : [content];

      for (const block of blocks) {
        if (!block) continue;

        // Some MCP servers return structured blocks like:
        // { type: "json", json: {...} } or { type: "resource", resource: {...} }
        if (typeof block === "object" && !Array.isArray(block)) {
          if (block.json && typeof block.json === "object") return block.json;
          if (block.data && typeof block.data === "object") return block.data;
          if (typeof block.text === "string") {
            const txt = block.text.trim();
            if (txt) {
              const parsed = tryParseJsonFromText(txt);
              if (parsed) return parsed;
            }
          }
          if (block.resource) {
            if (typeof block.resource === "object") {
              if (typeof block.resource.text === "string") {
                const txt = block.resource.text.trim();
                if (txt) {
                  const parsed = tryParseJsonFromText(txt);
                  if (parsed) return parsed;
                }
              }
              if (block.resource.data && typeof block.resource.data === "object") return block.resource.data;
              if (block.resource.json && typeof block.resource.json === "object") return block.resource.json;
              return block.resource;
            }
            if (typeof block.resource === "string") {
              const txt = block.resource.trim();
              if (txt) {
                const parsed = tryParseJsonFromText(txt);
                if (parsed) return parsed;
              }
            }
          }
        }

        // Common MCP text block: { type: "text", text: "..." }
        if (typeof block === "object" && typeof block.text === "string") {
          const txt = block.text.trim();
          if (!txt) continue;
          const parsed = tryParseJsonFromText(txt);
          if (parsed) return parsed;
        }

        // Sometimes tools may return the object directly
        if (typeof block === "object" && !Array.isArray(block)) {
          return block;
        }

        if (typeof block === "string") {
          const txt = block.trim();
          if (!txt) continue;
          const parsed = tryParseJsonFromText(txt);
          if (parsed) return parsed;
        }
      }

      return null;
    } catch (e) {
      console.error("Error parsing tool response content:", e);
      return null;
    }
  };

  /**
   * Handles a tool error response
   * @param {Object} toolUseResponse - The error response from the tool
   * @param {string} toolName - The name of the tool
   * @param {string} toolUseId - The ID of the tool use request
   * @param {Array} conversationHistory - The conversation history
   * @param {Function} sendMessage - Function to send messages to the client
   * @param {string} conversationId - The conversation ID
   */
  const handleToolError = async (
    toolUseResponse,
    toolName,
    toolUseId,
    conversationHistory,
    sendMessage,
    conversationId
  ) => {
    if (toolUseResponse.error.type === "auth_required") {
      console.log("Auth required for tool:", toolName);
      await addToolResultToHistory(
        conversationHistory,
        toolUseId,
        toolUseResponse.error.data,
        conversationId,
        toolName
      );
      sendMessage({ type: "auth_required" });
    } else {
      console.log("Tool use error", toolUseResponse.error);
      await addToolResultToHistory(
        conversationHistory,
        toolUseId,
        toolUseResponse.error.data,
        conversationId,
        toolName
      );
    }
  };

  /**
   * Handles a successful tool response
   * @param {Object} toolUseResponse - The response from the tool
   * @param {string} toolName - The name of the tool
   * @param {string} toolUseId - The ID of the tool use request
   * @param {Array} conversationHistory - The conversation history
   * @param {Array} productsToDisplay - Array to add product results to
   * @param {string} conversationId - The conversation ID
   */
  const handleToolSuccess = async (
    toolUseResponse,
    toolName,
    toolUseId,
    conversationHistory,
    productsToDisplay,
    conversationId
  ) => {
    // Check if this is a product search result
    if (toolName === AppConfig.tools.productSearchName) {
      productsToDisplay.push(...processProductSearchResult(toolUseResponse));
    }

    // Also show a product card when the model fetches product details
    if (toolName === AppConfig.tools.productDetailsName) {
      const detailsProducts = processProductDetailsResult(toolUseResponse);
      console.log(`Processing product details result → ${detailsProducts.length} product(s) to display`);
      productsToDisplay.push(...detailsProducts);
    }

    addToolResultToHistory(conversationHistory, toolUseId, toolUseResponse.content, conversationId, toolName);
  };

  /**
   * Processes product search results
   * @param {Object} toolUseResponse - The response from the tool
   * @returns {Array} Processed product data
   */
  const processProductSearchResult = (toolUseResponse) => {
    try {
      console.log("Processing product search result");
      let products = [];

      const responseData = parseToolResponseData(toolUseResponse);

      if (responseData?.products && Array.isArray(responseData.products)) {
        products = responseData.products
          .slice(0, AppConfig.tools.maxProductsToDisplay)
          .map(formatProductData);

        console.log(`Found ${products.length} products to display`);
      }

      return products;
    } catch (error) {
      console.error("Error processing product search results:", error);
      return [];
    }
  };

  /**
   * Processes product details results
   * @param {Object} toolUseResponse - The response from the tool
   * @returns {Array} Array with a single formatted product (or empty)
   */
  const processProductDetailsResult = (toolUseResponse) => {
    try {
      let products = [];

      const responseData = parseToolResponseData(toolUseResponse);
      if (!responseData) return [];

      // Common shapes
      const rawProduct =
        responseData?.product ||
        responseData?.data?.product ||
        responseData?.products?.[0] ||
        responseData;

      if (rawProduct && typeof rawProduct === "object") {
        products = [formatProductData(rawProduct)];
      }

      return products;
    } catch (error) {
      console.error("Error processing product details results:", error);
      return [];
    }
  };

  /**
   * Formats a product data object
   * @param {Object} product - Raw product data
   * @returns {Object} Formatted product data
   */
  const formatProductData = (product) => {
    const deepFindFirstString = (obj, keys) => {
      try {
        const keySet = new Set(keys);
        const visited = new Set();

        const visit = (value) => {
          if (!value) return undefined;
          if (typeof value === "string") return undefined;
          if (typeof value !== "object") return undefined;
          if (visited.has(value)) return undefined;
          visited.add(value);

          if (Array.isArray(value)) {
            for (const item of value) {
              const found = visit(item);
              if (found) return found;
            }
            return undefined;
          }

          for (const [k, v] of Object.entries(value)) {
            if (keySet.has(k) && typeof v === "string" && v) return v;
          }

          for (const v of Object.values(value)) {
            const found = visit(v);
            if (found) return found;
          }

          return undefined;
        };

        return visit(obj);
      } catch {
        return undefined;
      }
    };

    const deepFindFirstStringWhere = (obj, predicate) => {
      try {
        const visited = new Set();

        const visit = (value) => {
          if (value == null) return undefined;
          if (typeof value === "string") {
            return predicate(value) ? value : undefined;
          }
          if (typeof value !== "object") return undefined;
          if (visited.has(value)) return undefined;
          visited.add(value);

          if (Array.isArray(value)) {
            for (const item of value) {
              const found = visit(item);
              if (found) return found;
            }
            return undefined;
          }

          for (const v of Object.values(value)) {
            const found = visit(v);
            if (found) return found;
          }

          return undefined;
        };

        return visit(obj);
      } catch {
        return undefined;
      }
    };

    const price = product.price_range
      ? `${product.price_range.currency} ${product.price_range.min}`
      : product.variants && product.variants.length > 0
        ? `${product.variants[0].currency} ${product.variants[0].price}`
        : "Price not available";

    // MCP storefront tools often expose a single variant under `selectedOrFirstAvailableVariant`.
    // Prefer that, then fall back to variants[0].
    const firstVariant =
      product && typeof product === "object" && product.selectedOrFirstAvailableVariant && typeof product.selectedOrFirstAvailableVariant === "object"
        ? product.selectedOrFirstAvailableVariant
        : product.variants && product.variants.length > 0
          ? product.variants[0]
          : null;
    const variantId =
      (firstVariant && typeof firstVariant.variant_id === "string" ? firstVariant.variant_id : null) ||
      (firstVariant && typeof firstVariant.id === "string" ? firstVariant.id : null) ||
      (firstVariant && typeof firstVariant.id === "number" ? String(firstVariant.id) : null) ||
      undefined;

    const handle =
      (typeof product.handle === "string" && product.handle ? product.handle : undefined) ||
      (typeof product.product_handle === "string" && product.product_handle ? product.product_handle : undefined) ||
      (typeof product.productHandle === "string" && product.productHandle ? product.productHandle : undefined) ||
      deepFindFirstString(product, ["handle", "product_handle", "productHandle"]) ||
      undefined;

    const isLikelyProductPageUrl = (candidate) => {
      if (typeof candidate !== "string") return false;
      const u = candidate.trim();
      if (!u) return false;
      // Reject obvious CDN/file links
      if (/cdn\.shopify\.com/i.test(u)) return false;
      if (/\.(png|jpe?g|webp|gif|svg)(\?|#|$)/i.test(u)) return false;
      // Accept relative or absolute product page URLs
      if (u.startsWith("/products/")) return true;
      return /\/products\//i.test(u);
    };

    const rawUrlCandidate =
      (typeof product.url === "string" && product.url ? product.url : undefined) ||
      (typeof product.product_url === "string" && product.product_url ? product.product_url : undefined) ||
      (typeof product.productUrl === "string" && product.productUrl ? product.productUrl : undefined) ||
      (typeof product.online_store_url === "string" && product.online_store_url ? product.online_store_url : undefined) ||
      (typeof product.onlineStoreUrl === "string" && product.onlineStoreUrl ? product.onlineStoreUrl : undefined) ||
      // Deep search but avoid the overly generic "url" key to reduce false positives (like image.url)
      deepFindFirstString(product, [
        "product_url",
        "productUrl",
        "online_store_url",
        "onlineStoreUrl",
        "online_store_preview_url",
        "onlineStorePreviewUrl",
      ]) ||
      "";

    // Extra fallback: some MCP servers only provide a product page URL under a nested `url` field
    // (or embed it in text). We look for any string containing "/products/" and validate it.
    const deepProductUrlCandidate = isLikelyProductPageUrl(rawUrlCandidate)
      ? rawUrlCandidate
      : deepFindFirstStringWhere(product, (s) => isLikelyProductPageUrl(s)) || "";

    const url = (deepProductUrlCandidate ? String(deepProductUrlCandidate).trim() : "") || (handle ? `/products/${handle}` : "");

    // If we got a product page URL but no handle, derive handle from URL (helps frontend linking).
    const derivedHandle = (() => {
      try {
        const u = typeof url === "string" ? url : "";
        const m = u.match(/\/products\/([a-z0-9-]+)\b/i);
        return m && m[1] ? m[1] : null;
      } catch {
        return null;
      }
    })();

    return {
      // Preserve real identifiers whenever possible (important for link rewriting and product details lookups)
      id:
        typeof product.product_id === "string" && product.product_id
          ? product.product_id
          : typeof product.productId === "string" && product.productId
            ? product.productId
            : typeof product.id === "string" && product.id
              ? product.id
              : typeof product.id === "number" && Number.isFinite(product.id)
                ? String(product.id)
                : `product-${Math.random().toString(36).substring(7)}`,
      title: product.title || "Product",
      price: price,
      image_url: product.image_url || "",
      description: product.description || "",
      handle: handle || derivedHandle || undefined,
      url,
      variant_id: variantId,
    };
  };

  /**
   * Adds a tool result to the conversation history
   * @param {Array} conversationHistory - The conversation history
   * @param {string} toolUseId - The ID of the tool use request
   * @param {string} content - The content of the tool result
   * @param {string} conversationId - The conversation ID
   */
  const addToolResultToHistory = async (conversationHistory, toolUseId, content, conversationId, toolName) => {
    const toolResultMessage = {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseId,
          tool_name: toolName || undefined,
          content: content,
        },
      ],
    };

    // Add to in-memory history
    conversationHistory.push(toolResultMessage);

    // Save to database with special format to indicate tool result
    if (conversationId) {
      try {
        await saveMessage(conversationId, "user", JSON.stringify(toolResultMessage.content));
      } catch (error) {
        console.error("Error saving tool result to database:", error);
      }
    }
  };

  return {
    handleToolError,
    handleToolSuccess,
    processProductSearchResult,
    processProductDetailsResult,
    addToolResultToHistory,
  };
}

export default {
  createToolService,
};
