/**
 * Chat API Route
 * Handles chat interactions with Claude API and tools
 */
import MCPClient from "../mcp-client";
import { saveMessage, getConversationHistory, storeCustomerAccountUrls, getCustomerAccountUrls as getCustomerAccountUrlsFromDb } from "../db.server";
import AppConfig from "../services/config.server";
import { createSseStream } from "../services/streaming.server";
import { createClaudeService } from "../services/claude.server";
import { createToolService } from "../services/tool.server";
import { unauthenticated } from "../shopify.server";


/**
 * Rract Router loader function for handling GET requests
 */
export async function loader({ request }) {
  // Handle OPTIONS requests (CORS preflight)
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: getCorsHeaders(request)
    });
  }

  const url = new URL(request.url);

  // Handle history fetch requests - matches /chat?history=true&conversation_id=XYZ
  if (url.searchParams.has('history') && url.searchParams.has('conversation_id')) {
    return handleHistoryRequest(request, url.searchParams.get('conversation_id'));
  }

  // Handle SSE requests
  if (!url.searchParams.has('history') && request.headers.get("Accept") === "text/event-stream") {
    return handleChatRequest(request);
  }

  // API-only: reject all other requests
  return new Response(JSON.stringify({ error: AppConfig.errorMessages.apiUnsupported }), { status: 400, headers: getCorsHeaders(request) });
}

/**
 * React Router action function for handling POST requests
 */
export async function action({ request }) {
  return handleChatRequest(request);
}

/**
 * Handle history fetch requests
 * @param {Request} request - The request object
 * @param {string} conversationId - The conversation ID
 * @returns {Response} JSON response with chat history
 */
async function handleHistoryRequest(request, conversationId) {
  const messages = await getConversationHistory(conversationId);

  return new Response(JSON.stringify({ messages }), { headers: getCorsHeaders(request) });
}

/**
 * Handle chat requests (both GET and POST)
 * @param {Request} request - The request object
 * @returns {Response} Server-sent events stream
 */
async function handleChatRequest(request) {
  try {
    // Get message data from request body
    const body = await request.json();
    const userMessage = body.message;

    // Validate required message
    if (!userMessage) {
      return new Response(
        JSON.stringify({ error: AppConfig.errorMessages.missingMessage }),
        { status: 400, headers: getSseHeaders(request) }
      );
    }

    // Generate or use existing conversation ID
    const conversationId = body.conversation_id || Date.now().toString();
    const promptType = body.prompt_type || AppConfig.api.defaultPromptType;

    // Create a stream for the response
    const responseStream = createSseStream(async (stream) => {
      await handleChatSession({
        request,
        userMessage,
        conversationId,
        promptType,
        stream
      });
    });

    return new Response(responseStream, {
      headers: getSseHeaders(request)
    });
  } catch (error) {
    console.error('Error in chat request handler:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: getCorsHeaders(request)
    });
  }
}

/**
 * Handle a complete chat session
 * @param {Object} params - Session parameters
 * @param {Request} params.request - The request object
 * @param {string} params.userMessage - The user's message
 * @param {string} params.conversationId - The conversation ID
 * @param {string} params.promptType - The prompt type
 * @param {Object} params.stream - Stream manager for sending responses
 */
async function handleChatSession({
  request,
  userMessage,
  conversationId,
  promptType,
  stream
}) {
  // Tools we intentionally hide/disable. (We prefer Online Store cart via /cart.js + /cart/add.js.)
  const DISABLED_MCP_TOOLS = new Set(["update_cart", "get_cart"]);
  const CATALOG_SEARCH_TOOL = AppConfig.tools.productSearchName;
  const PRODUCT_DETAILS_TOOL = AppConfig.tools.productDetailsName;

  // Initialize services
  const claudeService = createClaudeService();
  const toolService = createToolService();

  // Initialize MCP client
  const shopId = request.headers.get("X-Shopify-Shop-Id");
  const shopDomain = request.headers.get("Origin");
  const { mcpApiUrl } = await getCustomerAccountUrls(shopDomain, conversationId);

  const mcpClient = new MCPClient(
    shopDomain,
    conversationId,
    shopId,
    mcpApiUrl,
  );

  try {
    // Send conversation ID to client
    stream.sendMessage({ type: 'id', conversation_id: conversationId });

    // Connect to MCP servers and get available tools
    let storefrontMcpTools = [], customerMcpTools = [];

    try {
      storefrontMcpTools = await mcpClient.connectToStorefrontServer();
      customerMcpTools = await mcpClient.connectToCustomerServer();

      console.log(`Connected to MCP with ${storefrontMcpTools.length} tools`);
      console.log(`Connected to customer MCP with ${customerMcpTools.length} tools`);
    } catch (error) {
      console.warn('Failed to connect to MCP servers, continuing without tools:', error.message);
    }

    // Hide disabled tools from the model (so it won't try calling them).
    if (Array.isArray(mcpClient.tools) && mcpClient.tools.length > 0) {
      mcpClient.tools = mcpClient.tools.filter((t) => !DISABLED_MCP_TOOLS.has(t?.name));
    }

    // Prepare conversation state
    let conversationHistory = [];
    let productsToDisplay = [];

    // Save user message to the database
    await saveMessage(conversationId, 'user', userMessage);

    // Fetch all messages from the database for this conversation
    const dbMessages = await getConversationHistory(conversationId);

    // Format messages for Claude API
    conversationHistory = dbMessages.map(dbMessage => {
      let content;
      try {
        content = JSON.parse(dbMessage.content);
      } catch (e) {
        content = dbMessage.content;
      }
      return {
        role: dbMessage.role,
        content
      };
    });

    /**
     * Auto-run catalog search so product cards show up even if the model doesn't call tools.
     * This is especially important for follow-ups like "à dessert" after a user said
     * "je cherche des assiettes".
     */
    const autoSearchCatalogIfNeeded = async () => {
      try {
        if (!Array.isArray(mcpClient.tools) || mcpClient.tools.length === 0) return;
        if (!mcpClient.tools.some(t => t?.name === CATALOG_SEARCH_TOOL)) return;

        const raw = (userMessage || '').trim();
        if (!raw) return;

        // Skip obvious non-search inputs
        if (/^\d+$/.test(raw)) return; // ordinal selection handled client-side

        const lower = raw.toLowerCase();
        const looksLikeSearch =
          /\b(cherche|recherche|trouve|montre|montrez|voir|besoin|voudrais|aimerais)\b/i.test(lower) ||
          /\b(assiette|assiettes|casserole|casseroles|poele|poêles|couteau|couteaux|verre|verres)\b/i.test(lower);

        const isShortRefinement = raw.length <= 30 && /\b(dessert|inox|petite|petit|moyenne|moyen|grande|grand|plate|creuse)\b/i.test(lower);

        if (!looksLikeSearch && !isShortRefinement) return;

        const previousUserQuery = getPreviousUserTextMessage(conversationHistory);
        const query = (isShortRefinement && previousUserQuery)
          ? `${previousUserQuery} ${raw}`
          : raw;

        console.log(`Auto catalog search: ${query}`);
        const toolUseResponse = await mcpClient.callTool(CATALOG_SEARCH_TOOL, {
          query,
          context: `Customer is searching for products. Use the query to find relevant items.`,
        });

        if (toolUseResponse?.error) return;

        const products = toolService.processProductSearchResult(toolUseResponse);
        if (products && products.length > 0) {
          // Best-effort enrichment: fetch product details to get a handle/url for clickable product cards.
          if (Array.isArray(mcpClient.tools) &&
              mcpClient.tools.some(t => t?.name === PRODUCT_DETAILS_TOOL)) {
            for (const p of products) {
              if (p && (!p.url || p.url === '')) {
                try {
                  const detailsResponse = await mcpClient.callTool(PRODUCT_DETAILS_TOOL, { product_id: p.id });
                  if (!detailsResponse?.error) {
                    const detailsProducts = toolService.processProductDetailsResult(detailsResponse);
                    const details = Array.isArray(detailsProducts) ? detailsProducts[0] : null;
                    if (details?.url) p.url = details.url;
                    if (details?.handle) p.handle = details.handle;
                    if (details?.url || details?.handle) {
                      console.log(`Enriched product ${p.id}:`, { url: details?.url, handle: details?.handle });
                    }
                  }
                } catch (e) {
                  console.warn('Product details enrichment failed:', e?.message || e);
                }
              }
            }
          }

          // Fallback enrichment via Admin API offline session (more reliable for handle/url).
          const shop = getShopFromOrigin(shopDomain);
          if (shop) {
            for (const p of products) {
              if (!p) continue;
              if ((p.url && p.url !== '') || (p.handle && p.handle !== '')) continue;
              try {
                const handle = await resolveProductHandleViaAdmin(shop, p.id);
                if (handle) {
                  p.handle = handle;
                  p.url = `/products/${handle}`;
                  console.log(`Admin-enriched product ${p.id}:`, { handle });
                }
              } catch (e) {
                console.warn('Admin enrichment failed:', e?.message || e);
              }
            }
          }

          productsToDisplay.push(...products);
        }
      } catch (e) {
        console.warn('Auto catalog search failed:', e?.message || e);
      }
    };

    await autoSearchCatalogIfNeeded();

    // Execute the conversation stream
    let finalMessage = { role: 'user', content: userMessage };

    while (finalMessage.stop_reason !== "end_turn") {
      finalMessage = await claudeService.streamConversation(
        {
          messages: conversationHistory,
          promptType,
          tools: mcpClient.tools
        },
        {
          // Handle text chunks
          onText: (textDelta) => {
            stream.sendMessage({
              type: 'chunk',
              chunk: textDelta
            });
          },

          // Handle complete messages
          onMessage: (message) => {
            conversationHistory.push({
              role: message.role,
              content: message.content
            });

            saveMessage(conversationId, message.role, JSON.stringify(message.content))
              .catch((error) => {
                console.error("Error saving message to database:", error);
              });

            // Send a completion message
            stream.sendMessage({ type: 'message_complete' });
          },

          // Handle tool use requests
          onToolUse: async (content) => {
            const toolName = content.name;
            const toolArgs = content.input;
            const toolUseId = content.id;

            if (DISABLED_MCP_TOOLS.has(toolName)) {
              const msg = [
                `The tool \`${toolName}\` is disabled in this app.`,
                ``,
                `This store uses the **Online Store cart** as the source of truth:`,
                `- To **add items to cart**: use the storefront **Add to Cart** button (or add from the product page).`,
                `- To **view your cart**: go to \`/cart\``,
              ].join('\n');

              stream.sendMessage({
                type: 'tool_use',
                tool_use_message: `Blocked tool: ${toolName}`
              });

              await toolService.addToolResultToHistory(
                conversationHistory,
                toolUseId,
                msg,
                conversationId
              );

              stream.sendMessage({ type: 'new_message' });
              return;
            }

            const augmentedToolArgs = augmentToolArgsWithCartState({
              toolName,
              toolArgs,
              tools: mcpClient.tools,
              conversationHistory,
            });

            const toolUseMessage = `Calling tool: ${toolName} with arguments: ${JSON.stringify(augmentedToolArgs)}`;

            stream.sendMessage({
              type: 'tool_use',
              tool_use_message: toolUseMessage
            });

            // Call the tool
            const toolUseResponse = await mcpClient.callTool(toolName, augmentedToolArgs);

            // Handle tool response based on success/error
            if (toolUseResponse.error) {
              await toolService.handleToolError(
                toolUseResponse,
                toolName,
                toolUseId,
                conversationHistory,
                stream.sendMessage,
                conversationId
              );
            } else {
              await toolService.handleToolSuccess(
                toolUseResponse,
                toolName,
                toolUseId,
                conversationHistory,
                productsToDisplay,
                conversationId
              );
            }

            // Signal new message to client
            stream.sendMessage({ type: 'new_message' });
          },

          // Handle content block completion
          onContentBlock: (contentBlock) => {
            if (contentBlock.type === 'text') {
              stream.sendMessage({
                type: 'content_block_complete',
                content_block: contentBlock
              });
            }
          }
        }
      );
    }

    // Signal end of turn
    stream.sendMessage({ type: 'end_turn' });

    // Send product results if available
    if (productsToDisplay.length > 0) {
      stream.sendMessage({
        type: 'product_results',
        products: productsToDisplay
      });
    }
  } catch (error) {
    // The streaming handler takes care of error handling
    throw error;
  }
}

function getPreviousUserTextMessage(conversationHistory) {
  if (!Array.isArray(conversationHistory) || conversationHistory.length < 2) return null;

  // Walk backwards, skipping the most recent message (current user input is already included)
  for (let i = conversationHistory.length - 2; i >= 0; i--) {
    const msg = conversationHistory[i];
    if (msg?.role !== 'user') continue;
    if (typeof msg?.content === 'string' && msg.content.trim().length > 0) return msg.content.trim();
  }
  return null;
}

function getShopFromOrigin(origin) {
  try {
    if (!origin) return null;
    const { hostname } = new URL(origin);
    return hostname || null;
  } catch {
    return null;
  }
}

const productHandleCache = new Map(); // key: `${shop}:${productGid}` -> handle|null
async function resolveProductHandleViaAdmin(shop, productGid) {
  const key = `${shop}:${productGid}`;
  if (productHandleCache.has(key)) return productHandleCache.get(key);

  const { admin } = await unauthenticated.admin(shop);

  const resp = await admin.graphql(
    `#graphql
    query ProductHandle($id: ID!) {
      product(id: $id) {
        handle
      }
    }`,
    { variables: { id: productGid } }
  );

  const json = await resp.json();
  const handle = json?.data?.product?.handle || null;
  productHandleCache.set(key, handle);
  return handle;
}

/**
 * Get the customer MCP API URL for a shop
 * @param {string} shopDomain - The shop domain
 * @param {string} conversationId - The conversation ID
 * @returns {string} The customer MCP API URL
 */
async function getCustomerAccountUrls(shopDomain, conversationId) {
  try {
    // Check if the customer account URL exists in the DB
    const existingUrls = await getCustomerAccountUrlsFromDb(conversationId);

    // If URL exists, return early with the MCP API URL
    if (existingUrls) return existingUrls;

    // If not, query for it from the Shopify API
    const { hostname } = new URL(shopDomain);

    const urls = await Promise.all([
      fetch(`https://${hostname}/.well-known/customer-account-api`).then(res => res.json()),
      fetch(`https://${hostname}/.well-known/openid-configuration`).then(res => res.json()),
    ]).then(async ([mcpResponse, openidResponse]) => {
      const response = {
        mcpApiUrl: mcpResponse.mcp_api,
        authorizationUrl: openidResponse.authorization_endpoint,
        tokenUrl: openidResponse.token_endpoint,
      };

      await storeCustomerAccountUrls({
        conversationId,
        mcpApiUrl: mcpResponse.mcp_api,
        authorizationUrl: openidResponse.authorization_endpoint,
        tokenUrl: openidResponse.token_endpoint,
      });

      return response;
    });

    return urls;
  } catch (error) {
    console.error("Error getting customer MCP API URL:", error);
    return null;
  }
}

/**
 * Gets CORS headers for the response
 * @param {Request} request - The request object
 * @returns {Object} CORS headers object
 */
function getCorsHeaders(request) {
  const origin = request.headers.get("Origin") || "*";
  const requestHeaders = request.headers.get("Access-Control-Request-Headers") || "Content-Type, Accept";

  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": requestHeaders,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Max-Age": "86400" // 24 hours
  };
}

/**
 * Get SSE headers for the response
 * @param {Request} request - The request object
 * @returns {Object} SSE headers object
 */
function getSseHeaders(request) {
  const origin = request.headers.get("Origin") || "*";

  return {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET,OPTIONS,POST",
    "Access-Control-Allow-Headers": "X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version"
  };
}

/**
 * Attempts to find the last known cart state (cartId + checkoutUrl) by scanning tool_result blocks.
 * We intentionally keep this schema-agnostic since MCP tool responses can vary by version.
 */
function getLatestCartStateFromConversation(conversationHistory) {
  if (!Array.isArray(conversationHistory) || conversationHistory.length === 0) return null;

  for (let i = conversationHistory.length - 1; i >= 0; i--) {
    const message = conversationHistory[i];
    const blocks = Array.isArray(message?.content) ? message.content : [message?.content].filter(Boolean);

    for (const block of blocks) {
      if (!block || block.type !== "tool_result") continue;

      const extracted = extractCartStateFromUnknown(block.content);
      if (extracted?.cartId || extracted?.checkoutUrl) return extracted;
    }
  }

  return null;
}

function extractCartStateFromUnknown(value) {
  // 1) Direct object shapes
  const direct = extractCartStateFromObject(value);
  if (direct?.cartId || direct?.checkoutUrl) return direct;

  // 2) Arrays of content blocks from MCP tools, e.g. [{ type: "text", text: "..." }]
  if (Array.isArray(value)) {
    for (const item of value) {
      const fromItem = extractCartStateFromUnknown(item);
      if (fromItem?.cartId || fromItem?.checkoutUrl) return fromItem;
    }
  }

  // 3) Text: try JSON then regex
  if (typeof value === "string") {
    const trimmed = value.trim();

    // JSON payload inside a text block
    if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
      try {
        const parsed = JSON.parse(trimmed);
        const fromJson = extractCartStateFromUnknown(parsed);
        if (fromJson?.cartId || fromJson?.checkoutUrl) return fromJson;
      } catch {
        // ignore JSON parse errors and fall back to regex
      }
    }

    // Common IDs look like gid://shopify/Cart/...
    const cartIdMatch = trimmed.match(/gid:\/\/shopify\/Cart\/[^\s"'}\]]+/);

    // Checkout URLs vary by shop; we look for a /checkouts/ segment
    const checkoutUrlMatch = trimmed.match(/https?:\/\/[^\s"'}\]]*\/checkouts\/[^\s"'}\]]+/);

    return {
      cartId: cartIdMatch ? cartIdMatch[0] : undefined,
      checkoutUrl: checkoutUrlMatch ? checkoutUrlMatch[0] : undefined,
    };
  }

  // 4) Typical MCP text block shape: { type: "text", text: "..." }
  if (value && typeof value === "object" && typeof value.text === "string") {
    return extractCartStateFromUnknown(value.text);
  }

  return null;
}

function extractCartStateFromObject(obj) {
  if (!obj || typeof obj !== "object") return null;

  // Common field names
  const cartId =
    typeof obj.cartId === "string" ? obj.cartId :
    typeof obj.cart_id === "string" ? obj.cart_id :
    undefined;

  const checkoutUrl =
    typeof obj.checkoutUrl === "string" ? obj.checkoutUrl :
    typeof obj.checkout_url === "string" ? obj.checkout_url :
    undefined;

  if (cartId || checkoutUrl) return { cartId, checkoutUrl };

  // Deep search for cart gid / checkout URL (best-effort)
  for (const value of Object.values(obj)) {
    const extracted = extractCartStateFromUnknown(value);
    if (extracted?.cartId || extracted?.checkoutUrl) return extracted;
  }

  return null;
}

function pickCartIdArgLocationForTool(toolName, tools) {
  const tool = Array.isArray(tools) ? tools.find(t => t?.name === toolName) : null;
  const schema = tool?.input_schema;
  const props = schema?.properties;

  // Prefer explicit cart id property if present
  if (props && typeof props === "object") {
    const keys = Object.keys(props);
    const directKey =
      keys.find(k => k === "cartId") ||
      keys.find(k => k === "cart_id") ||
      keys.find(k => /cart.*id/i.test(k));

    if (directKey) return { type: "direct", key: directKey };

    // Some schemas may nest under `cart: { id: ... }`
    const cartProp = props.cart;
    if (cartProp?.type === "object" && cartProp?.properties?.id) {
      return { type: "nested", key: "cart", nestedKey: "id" };
    }
  }

  // Default (most common)
  return { type: "direct", key: "cartId" };
}

function hasAnyCartIdArg(toolArgs) {
  if (!toolArgs || typeof toolArgs !== "object") return false;
  if (typeof toolArgs.cartId === "string" && toolArgs.cartId.length > 0) return true;
  if (typeof toolArgs.cart_id === "string" && toolArgs.cart_id.length > 0) return true;
  if (toolArgs.cart && typeof toolArgs.cart === "object" && typeof toolArgs.cart.id === "string" && toolArgs.cart.id.length > 0) return true;
  return false;
}

/**
 * Ensures cart tools reuse the existing cart rather than creating a new one.
 * Today we only auto-augment `update_cart`, but the logic is generic.
 */
function augmentToolArgsWithCartState({ toolName, toolArgs, tools, conversationHistory }) {
  const args = (toolArgs && typeof toolArgs === "object") ? { ...toolArgs } : {};

  if (toolName !== "update_cart") return args;
  if (hasAnyCartIdArg(args)) return args;

  const latest = getLatestCartStateFromConversation(conversationHistory);
  if (!latest?.cartId) return args;

  const location = pickCartIdArgLocationForTool(toolName, tools);

  if (location.type === "nested") {
    args[location.key] = { ...(args[location.key] || {}), [location.nestedKey]: latest.cartId };
    return args;
  }

  args[location.key] = latest.cartId;
  return args;
}
