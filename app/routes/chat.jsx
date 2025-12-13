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
import { createProductRequestWorkflow } from "../services/product-request-workflow.server";
import { unauthenticated } from "../shopify.server";

const PRODUCT_WORKFLOW_DEBUG =
  process.env.PRODUCT_WORKFLOW_DEBUG === "1" ||
  process.env.PRODUCT_WORKFLOW_DEBUG === "true";

function productDebugLog(...args) {
  if (!PRODUCT_WORKFLOW_DEBUG) return;
  console.log("[product-workflow][chat-route]", ...args);
}

function productInfoLog(...args) {
  console.log("[product-workflow][chat-route]", ...args);
}


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
    let lastAssistantText = '';

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

    const enrichProductsWithLinks = async (products) => {
      try {
        if (!Array.isArray(products) || products.length === 0) return;

        // 1) Try MCP product details tool first (best-effort, no extra Shopify sessions needed)
        if (Array.isArray(mcpClient.tools) &&
            mcpClient.tools.some(t => t?.name === PRODUCT_DETAILS_TOOL)) {
          for (const p of products) {
            if (!p) continue;
            if ((p.url && p.url !== '') || (p.handle && p.handle !== '')) continue;
            try {
              const detailsResponse = await mcpClient.callTool(PRODUCT_DETAILS_TOOL, { product_id: p.id });
              if (!detailsResponse?.error) {
                const detailsProducts = toolService.processProductDetailsResult(detailsResponse);
                const details = Array.isArray(detailsProducts) ? detailsProducts[0] : null;
                if (details?.url) p.url = details.url;
                if (details?.handle) p.handle = details.handle;
              }
            } catch (e) {
              console.warn('Product details enrichment failed:', e?.message || e);
            }
          }
        }

        // 2) Fallback: Storefront API offline context (if available)
        const shop = getShopFromOrigin(shopDomain);
        if (shop) {
          for (const p of products) {
            if (!p) continue;
            if ((p.url && p.url !== '') || (p.handle && p.handle !== '')) continue;
            try {
              const resolved = await resolveProductLinkViaStorefront(shop, p.id);
              const handle = resolved?.handle || null;
              const url = resolved?.url || null;

              if (handle) p.handle = handle;
              if (url) p.url = url;
              if (!p.url && p.handle) p.url = `/products/${p.handle}`;
            } catch (e) {
              console.warn('Storefront enrichment failed:', e?.message || e);
            }
          }
        }

        // Log a sample for debugging
        const sample = products.find(p => p && (p.url || p.handle));
        if (sample) {
          console.log('Product link enrichment sample:', { id: sample.id, url: sample.url, handle: sample.handle });
        } else {
          console.log('Product link enrichment: no url/handle could be resolved');
        }
      } catch (e) {
        console.warn('Product link enrichment failed:', e?.message || e);
      }
    };

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
          await enrichProductsWithLinks(products);
          productsToDisplay.push(...products);
        }
      } catch (e) {
        console.warn('Auto catalog search failed:', e?.message || e);
      }
    };

    /**
     * REQUIRED: For product requests, run analysis first, then a 2-step search:
     * 1) product name search
     * 2) refine by adjectives ONLY within the prior results
     *
     * This must run before engaging the main model.
     */
    const autoAnalyzeAndSearchProductsIfNeeded = async () => {
      try {
        const raw = (userMessage || '').trim();
        if (!raw) return false;

        // Reuse the existing refinement heuristic to preserve UX ("à dessert" after "assiettes")
        const previousUserQuery = getPreviousUserTextMessage(conversationHistory);
        const lower = raw.toLowerCase();
        const isShortRefinement = raw.length <= 30 && /\b(dessert|inox|petite|petit|moyenne|moyen|grande|grand|plate|creuse)\b/i.test(lower);
        const textForAnalysis = (isShortRefinement && previousUserQuery)
          ? `${previousUserQuery} ${raw}`
          : raw;

        productDebugLog("start", {
          raw,
          previousUserQuery,
          isShortRefinement,
          textForAnalysis,
          hasCatalogSearchTool: Array.isArray(mcpClient.tools) && mcpClient.tools.some(t => t?.name === CATALOG_SEARCH_TOOL),
        });

        productInfoLog("workflow_start", {
          conversationId,
          debugEnabled: PRODUCT_WORKFLOW_DEBUG,
          textForAnalysis,
          toolsCount: Array.isArray(mcpClient.tools) ? mcpClient.tools.length : 0,
        });

        const workflow = createProductRequestWorkflow({
          mcpClient,
          toolService,
          productSearchToolName: CATALOG_SEARCH_TOOL,
        });

        const { analysis, products } = await workflow.run({ textForAnalysis });

        // If analysis doesn't detect a product request, let the normal LLM flow proceed.
        if (!Array.isArray(analysis) || analysis.length === 0) {
          productDebugLog("no_product_detected", { analysis });
          productInfoLog("workflow_end_no_product_detected", {
            conversationId,
            debugEnabled: PRODUCT_WORKFLOW_DEBUG,
            hint: PRODUCT_WORKFLOW_DEBUG ? undefined : "Set PRODUCT_WORKFLOW_DEBUG=true to see detailed logs",
          });
          return false;
        }

        console.log("Product request analysis:", JSON.stringify(analysis));
        productDebugLog("product_detected", { analysisLen: analysis.length, productsLen: products?.length || 0 });
        productInfoLog("workflow_end_product_detected", {
          conversationId,
          analysisLen: analysis.length,
          productsLen: Array.isArray(products) ? products.length : 0,
        });

        if (Array.isArray(products) && products.length > 0) {
          await enrichProductsWithLinks(products);
          productsToDisplay.push(...products);
          productDebugLog("products_to_display_added", { added: products.length, total: productsToDisplay.length });
        } else {
          productDebugLog("no_products_found_after_search");
          productInfoLog("workflow_product_detected_but_no_products_found", { conversationId });
        }

        // We ran analysis before the main model. Return true even if search yielded no products.
        return true;
      } catch (e) {
        console.warn('Auto product analysis/search failed:', e?.message || e);
        productDebugLog("error", { message: e?.message || String(e) });
        productInfoLog("workflow_error", { conversationId, message: e?.message || String(e) });
        return false;
      }
    };

    const didRunProductWorkflow = await autoAnalyzeAndSearchProductsIfNeeded();
    if (!didRunProductWorkflow) {
      productInfoLog("workflow_skipped_fallback_to_legacy_auto_search", { conversationId });
      await autoSearchCatalogIfNeeded();
    }

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

            // Capture the assistant text so we can filter product cards to match what's actually listed.
            if (message?.role === 'assistant') {
              const text = extractTextFromClaudeContent(message.content);
              if (text) lastAssistantText = text;
            }

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
              const beforeLen = productsToDisplay.length;
              await toolService.handleToolSuccess(
                toolUseResponse,
                toolName,
                toolUseId,
                conversationHistory,
                productsToDisplay,
                conversationId
              );

              // If the tool produced product cards, enrich them with url/handle so images/titles are clickable.
              if (toolName === AppConfig.tools.productSearchName || toolName === AppConfig.tools.productDetailsName) {
                const newProducts = productsToDisplay.slice(beforeLen);
                await enrichProductsWithLinks(newProducts);
              }
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
      // If the assistant listed products that are missing from productsToDisplay (because the model
      // referenced items not present in tool results), try to resolve them via a targeted search.
      await backfillProductsFromAssistantText({
        assistantText: lastAssistantText,
        productsToDisplay,
        mcpClient,
        toolService,
        enrichProductsWithLinks,
        catalogSearchToolName: CATALOG_SEARCH_TOOL,
      });

      const filtered = filterProductsToMentionedInText(productsToDisplay, lastAssistantText);
      if (filtered.length !== productsToDisplay.length) {
        console.log('Filtering product cards to match assistant text:', {
          before: productsToDisplay.length,
          after: filtered.length,
          titles: extractListedProductTitlesFromAssistantText(lastAssistantText),
        });
      }
      stream.sendMessage({
        type: 'product_results',
        products: filtered
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

function extractTextFromClaudeContent(content) {
  try {
    const blocks = Array.isArray(content) ? content : [content].filter(Boolean);
    const texts = [];
    for (const block of blocks) {
      if (!block) continue;
      if (typeof block === 'string') texts.push(block);
      if (typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
        texts.push(block.text);
      }
    }
    return texts.join('\n').trim();
  } catch {
    return '';
  }
}

function normalizeForTitleMatch(s) {
  try {
    return String(s || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  } catch {
    return String(s || '').toLowerCase().trim();
  }
}

function extractListedProductTitlesFromAssistantText(text) {
  const raw = typeof text === 'string' ? text : '';
  if (!raw.trim()) return [];

  const titles = new Set();

  // Markdown links: [Title](url)
  for (const m of raw.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)) {
    const label = (m?.[1] || '').trim();
    if (label) titles.add(label);
  }

  // Bold-numbered paragraph patterns:
  // **1. Title** - **price**
  for (const m of raw.matchAll(/^\s*\*\*\s*\d+\s*[\.\)]\s*([^*]+?)\s*\*\*/gm)) {
    const label = (m?.[1] || '').trim();
    if (label) titles.add(label);
  }

  // Numbered lines like: 1. **Title** - **price**
  for (const m of raw.matchAll(/^\s*\d+\s*[\.\)]\s*\*\*([^*]+)\*\*/gm)) {
    const label = (m?.[1] || '').trim();
    if (label) titles.add(label);
  }

  // Numbered lines without bold: 1. Title - price
  for (const m of raw.matchAll(/^\s*\d+\s*[\.\)]\s*([^\n]+)$/gm)) {
    let line = (m?.[1] || '').trim();
    if (!line) continue;
    line = line.replace(/\*\*/g, '').trim();
    // Remove trailing price/extra info after " - "
    if (line.includes(' - ')) line = line.split(' - ')[0].trim();
    if (line) titles.add(line);
  }

  // Single bold title lines (no numbering), common when the model outputs:
  // **Title** - **price**
  for (const m of raw.matchAll(/^\s*\*\*([^*]+?)\*\*\s*-\s*\*\*/gm)) {
    const label = (m?.[1] || '').trim();
    if (label) titles.add(label);
  }

  return Array.from(titles);
}

function filterProductsToMentionedInText(products, assistantText) {
  const list = Array.isArray(products) ? products : [];
  const titles = extractListedProductTitlesFromAssistantText(assistantText);
  if (titles.length === 0) return list;

  const wanted = titles.map(normalizeForTitleMatch).filter(Boolean);
  if (wanted.length === 0) return list;

  const matched = list.filter((p) => {
    const pt = normalizeForTitleMatch(p?.title || '');
    if (!pt) return false;
    return wanted.some((w) => pt === w || pt.includes(w) || w.includes(pt));
  });

  return matched.length > 0 ? matched : list;
}

function bestMatchByTitle(candidates, wantedTitle) {
  const wanted = normalizeForTitleMatch(wantedTitle);
  if (!wanted) return { match: null, score: -1 };

  let best = null;
  let bestScore = -1;

  for (const c of Array.isArray(candidates) ? candidates : []) {
    const title = normalizeForTitleMatch(c?.title || '');
    if (!title) continue;

    let score = 0;
    if (title === wanted) score = 100;
    else if (title.includes(wanted)) score = 80;
    else if (wanted.includes(title)) score = 60;
    else {
      // crude overlap score
      const a = new Set(title.split(' ').filter(Boolean));
      const b = new Set(wanted.split(' ').filter(Boolean));
      let overlap = 0;
      for (const w of b) if (a.has(w)) overlap++;
      score = overlap;
    }

    if (score > bestScore) {
      best = c;
      bestScore = score;
    }
  }

  return { match: best, score: bestScore };
}

// In-memory cache for resolving "assistant-listed title" -> product card (best-effort).
// This avoids repeated MCP searches when testing the same titles.
const productBackfillCache = new Map(); // key: normalizedTitle -> { product, expiresAt }
const PRODUCT_BACKFILL_CACHE_TTL_MS = 10 * 60 * 1000;

function getCachedBackfillProduct(title) {
  try {
    const key = normalizeForTitleMatch(title);
    if (!key) return null;
    const entry = productBackfillCache.get(key);
    if (!entry) return null;
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      productBackfillCache.delete(key);
      return null;
    }
    return entry.product || null;
  } catch {
    return null;
  }
}

function setCachedBackfillProduct(title, product) {
  try {
    const key = normalizeForTitleMatch(title);
    if (!key || !product) return;
    productBackfillCache.set(key, { product, expiresAt: Date.now() + PRODUCT_BACKFILL_CACHE_TTL_MS });
  } catch {
    // ignore
  }
}

function stripDiacritics(s) {
  try {
    return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  } catch {
    return String(s || '');
  }
}

function generateSearchQueriesForTitle(title) {
  const raw = String(title || '').trim();
  if (!raw) return [];

  const queries = [];
  const push = (q) => {
    const v = String(q || '').trim();
    if (!v) return;
    if (!queries.includes(v)) queries.push(v);
  };

  // Full title
  push(raw);

  // Remove trailing price/extra info after " - " (if present in label)
  push(raw.split(' - ')[0]);

  // Remove common dimension patterns (e.g. "16 cm", "21cm")
  push(raw.replace(/\b\d+\s*cm\b/gi, '').replace(/\b\d+cm\b/gi, '').replace(/\s+/g, ' ').trim());

  // Remove everything after dash (often brand)
  if (raw.includes(' - ')) push(raw.split(' - ')[0].trim());

  // ASCII versions (helps when catalog search is accent-sensitive)
  for (const q of [...queries]) push(stripDiacritics(q));

  // Shorten: first 8 words (best-effort)
  const words = raw.split(/\s+/).filter(Boolean);
  if (words.length > 8) push(words.slice(0, 8).join(' '));

  // Keep it fast: cap to the first 2 distinct queries.
  return queries.filter(Boolean).slice(0, 2);
}

async function runWithConcurrencyLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;

  const worker = async () => {
    while (true) {
      const idx = next++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx], idx);
    }
  };

  const workers = [];
  const n = Math.max(1, Math.min(limit || 1, items.length));
  for (let i = 0; i < n; i++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

async function backfillProductsFromAssistantText({
  assistantText,
  productsToDisplay,
  mcpClient,
  toolService,
  enrichProductsWithLinks,
  catalogSearchToolName,
}) {
  try {
    if (!assistantText || typeof assistantText !== 'string') return;
    if (!Array.isArray(productsToDisplay)) return;
    if (!Array.isArray(mcpClient?.tools) || !mcpClient.tools.some((t) => t?.name === catalogSearchToolName)) return;

    const listedTitles = extractListedProductTitlesFromAssistantText(assistantText);
    if (listedTitles.length === 0) return;

    const isTitleCoveredByCurrentProducts = (wantedTitle) => {
      const w = normalizeForTitleMatch(wantedTitle);
      if (!w) return true;

      for (const p of productsToDisplay) {
        const pt = normalizeForTitleMatch(p?.title || '');
        if (!pt) continue;
        if (pt === w || pt.includes(w) || w.includes(pt)) return true;
      }

      return false;
    };

    // IMPORTANT: do NOT compare array lengths here (duplicates can cause false "complete" results).
    // Only skip backfill when every unique listed title is already covered by current products.
    const missingTitles = Array.from(new Set(listedTitles))
      .filter((t) => !isTitleCoveredByCurrentProducts(t));
    if (missingTitles.length === 0) return;

    // Resolve each missing title with a targeted catalog search
    const existingNormalized = new Set(productsToDisplay.map((p) => normalizeForTitleMatch(p?.title || '')).filter(Boolean));
    const toFetch = missingTitles.filter((t) => {
      const key = normalizeForTitleMatch(t);
      return key && !existingNormalized.has(key);
    });

    if (toFetch.length === 0) return;

    console.log('Backfilling missing product cards from assistant list:', { missing: toFetch });

    const newlyAdded = [];
    const resolved = await runWithConcurrencyLimit(toFetch, 3, async (title) => {
      // Cache hit
      const cached = getCachedBackfillProduct(title);
      if (cached) {
        return { title, product: cached, score: 999, fromCache: true };
      }

      const queries = generateSearchQueriesForTitle(title);
      let chosen = null;
      let chosenScore = -1;

      for (const query of queries) {
        const resp = await mcpClient.callTool(catalogSearchToolName, {
          query,
          context: 'Customer is searching for produits. Utilisez la requête pour trouver des articles pertinents.',
        });
        if (resp?.error) continue;

        const candidates = toolService.processProductSearchResult(resp);
        const { match, score } = bestMatchByTitle(candidates, title);
        if (match && score > chosenScore) {
          chosen = match;
          chosenScore = score;
        }

        // Good enough → stop early
        if (chosen && chosenScore >= 60) break;
      }

      if (chosen) setCachedBackfillProduct(title, chosen);
      return { title, product: chosen, score: chosenScore, fromCache: false };
    });

    for (const r of resolved) {
      if (!r?.product) continue;
      const key = normalizeForTitleMatch(r.product?.title || '');
      if (key && existingNormalized.has(key)) continue;
      if (key) existingNormalized.add(key);
      productsToDisplay.push(r.product);
      newlyAdded.push(r.product);
      console.log('Backfill added product:', { requestedTitle: r.title, matchedTitle: r.product?.title, score: r.score, fromCache: r.fromCache });
    }

    if (newlyAdded.length > 0) {
      await enrichProductsWithLinks(newlyAdded);
    }
  } catch (e) {
    console.warn('Backfill of missing product cards failed:', e?.message || e);
  }
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

const productLinkCache = new Map(); // key: `${shop}:${productGid}` -> {handle,url}|null

async function resolveProductLinkViaStorefront(shop, productGid) {
  const key = `${shop}:${productGid}`;
  if (productLinkCache.has(key)) return productLinkCache.get(key);

  try {
    const { storefront } = await unauthenticated.storefront(shop);
    const resp = await storefront.graphql(
      `#graphql
      query ProductLink($id: ID!) {
        product(id: $id) {
          handle
          onlineStoreUrl
        }
      }`,
      { variables: { id: productGid } }
    );
    const json = await resp.json();
    const handle = json?.data?.product?.handle || null;
    const onlineStoreUrl = json?.data?.product?.onlineStoreUrl || null;
    const result = handle || onlineStoreUrl ? { handle, url: onlineStoreUrl } : null;
    productLinkCache.set(key, result);
    return result;
  } catch (e) {
    productLinkCache.set(key, null);
    throw e;
  }
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
