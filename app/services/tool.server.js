/**
 * Tool Service
 * Manages tool execution and processing
 */
import { saveMessage } from "../db.server";
import AppConfig from "./config.server";

/**
 * Creates a tool service instance
 * @returns {Object} Tool service with methods for managing tools
 */
export function createToolService() {
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
      if (!content) return null;

      // If it's already an object (not an array), treat it as parsed.
      if (typeof content === 'object' && !Array.isArray(content)) return content;

      const blocks = Array.isArray(content) ? content : [content];

      for (const block of blocks) {
        if (!block) continue;

        // Common MCP text block: { type: "text", text: "..." }
        if (typeof block === 'object' && typeof block.text === 'string') {
          const txt = block.text.trim();
          if (!txt) continue;
          try { return JSON.parse(txt); } catch { /* ignore */ }
        }

        // Sometimes tools may return the object directly
        if (typeof block === 'object' && !Array.isArray(block)) {
          return block;
        }

        if (typeof block === 'string') {
          const txt = block.trim();
          if (!txt) continue;
          try { return JSON.parse(txt); } catch { /* ignore */ }
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
  const handleToolError = async (toolUseResponse, toolName, toolUseId, conversationHistory, sendMessage, conversationId) => {
    if (toolUseResponse.error.type === "auth_required") {
      console.log("Auth required for tool:", toolName);
      await addToolResultToHistory(conversationHistory, toolUseId, toolUseResponse.error.data, conversationId);
      sendMessage({ type: 'auth_required' });
    } else {
      console.log("Tool use error", toolUseResponse.error);
      await addToolResultToHistory(conversationHistory, toolUseId, toolUseResponse.error.data, conversationId);
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
  const handleToolSuccess = async (toolUseResponse, toolName, toolUseId, conversationHistory, productsToDisplay, conversationId) => {
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

    addToolResultToHistory(conversationHistory, toolUseId, toolUseResponse.content, conversationId);
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

      if (rawProduct && typeof rawProduct === 'object') {
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
    const price = product.price_range
      ? `${product.price_range.currency} ${product.price_range.min}`
      : (product.variants && product.variants.length > 0
        ? `${product.variants[0].currency} ${product.variants[0].price}`
        : 'Price not available');

    const firstVariant = (product.variants && product.variants.length > 0) ? product.variants[0] : null;
    const variantId =
      (firstVariant && typeof firstVariant.variant_id === 'string' ? firstVariant.variant_id : null) ||
      (firstVariant && typeof firstVariant.id === 'string' ? firstVariant.id : null) ||
      (firstVariant && typeof firstVariant.id === 'number' ? String(firstVariant.id) : null) ||
      undefined;

    const handle =
      (typeof product.handle === 'string' && product.handle) ? product.handle :
      (typeof product.product_handle === 'string' && product.product_handle) ? product.product_handle :
      (typeof product.productHandle === 'string' && product.productHandle) ? product.productHandle :
      undefined;

    const url =
      (typeof product.url === 'string' && product.url) ? product.url :
      (typeof product.product_url === 'string' && product.product_url) ? product.product_url :
      (typeof product.productUrl === 'string' && product.productUrl) ? product.productUrl :
      (typeof product.online_store_url === 'string' && product.online_store_url) ? product.online_store_url :
      (typeof product.onlineStoreUrl === 'string' && product.onlineStoreUrl) ? product.onlineStoreUrl :
      (handle ? `/products/${handle}` : '');

    return {
      id: product.product_id || `product-${Math.random().toString(36).substring(7)}`,
      title: product.title || 'Product',
      price: price,
      image_url: product.image_url || '',
      description: product.description || '',
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
  const addToolResultToHistory = async (conversationHistory, toolUseId, content, conversationId) => {
    const toolResultMessage = {
      role: 'user',
      content: [{
        type: "tool_result",
        tool_use_id: toolUseId,
        content: content
      }]
    };

    // Add to in-memory history
    conversationHistory.push(toolResultMessage);

    // Save to database with special format to indicate tool result
    if (conversationId) {
      try {
        await saveMessage(conversationId, 'user', JSON.stringify(toolResultMessage.content));
      } catch (error) {
        console.error('Error saving tool result to database:', error);
      }
    }
  };

  return {
    handleToolError,
    handleToolSuccess,
    processProductSearchResult,
    addToolResultToHistory
  };
}

export default {
  createToolService
};
