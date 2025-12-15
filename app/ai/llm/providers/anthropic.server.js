/**
 * Claude Service
 * Manages interactions with the Claude API
 */
import { Anthropic } from "@anthropic-ai/sdk";
import AppConfig from "../../../config/app-config.server";
import systemPrompts from "../../../prompts/prompts.json";

/**
 * Creates a Claude service instance
 * @param {string} apiKey - Claude API key
 * @returns {Object} Claude service with methods for interacting with Claude API
 */
export function createClaudeService(apiKey = process.env.CLAUDE_API_KEY) {
  // Initialize Claude client
  const anthropic = new Anthropic({
    apiKey: apiKey,
    baseURL: "https://api.anthropic.com",
  });

  /**
   * Anthropic is strict about content block schemas.
   * In particular, `tool_result` blocks must NOT include extra keys like `tool_name`.
   * We keep `tool_name` internally (useful for other providers), but strip it here.
   * @param {Array} messages
   */
  const sanitizeMessagesForAnthropic = (messages) => {
    const msgs = Array.isArray(messages) ? messages : [];
    return msgs.map((m) => {
      const role = m?.role;
      const content = m?.content;
      if (!content || typeof content === "string") return m;

      const blocks = Array.isArray(content) ? content : [content].filter(Boolean);
      const sanitized = blocks.map((b) => {
        if (!b || typeof b !== "object") return b;
        if (b.type !== "tool_result") return b;

        // Keep only allowed fields for Anthropic tool_result
        const out = {
          type: "tool_result",
          tool_use_id: b.tool_use_id,
          content: b.content,
        };
        if (typeof b.is_error === "boolean") out.is_error = b.is_error;
        return out;
      });

      return { role, content: sanitized };
    });
  };

  /**
   * Streams a conversation with Claude
   * @param {Object} params - Stream parameters
   * @param {Array} params.messages - Conversation history
   * @param {string} params.promptType - The type of system prompt to use
   * @param {Array} params.tools - Available tools for Claude
   * @param {Object} streamHandlers - Stream event handlers
   * @param {Function} streamHandlers.onText - Handles text chunks
   * @param {Function} streamHandlers.onMessage - Handles complete messages
   * @param {Function} streamHandlers.onToolUse - Handles tool use requests
   * @returns {Promise<Object>} The final message
   */
  const streamConversation = async (
    { messages, promptType = AppConfig.api.defaultPromptType, model, tools },
    streamHandlers
  ) => {
    // Get system prompt from configuration or use default
    const systemInstruction = getSystemPrompt(promptType);

    // Create stream
    const stream = await anthropic.messages.stream({
      model:
        typeof model === "string" && model.trim().length > 0
          ? model.trim()
          : AppConfig.api.defaultModel,
      max_tokens: AppConfig.api.maxTokens,
      system: systemInstruction,
      messages: sanitizeMessagesForAnthropic(messages),
      tools: tools && tools.length > 0 ? tools : undefined,
    });

    // Set up event handlers
    if (streamHandlers.onText) {
      stream.on("text", streamHandlers.onText);
    }

    if (streamHandlers.onMessage) {
      stream.on("message", streamHandlers.onMessage);
    }

    if (streamHandlers.onContentBlock) {
      stream.on("contentBlock", streamHandlers.onContentBlock);
    }

    // Wait for final message
    const finalMessage = await stream.finalMessage();

    // Process tool use requests
    if (streamHandlers.onToolUse && finalMessage.content) {
      for (const content of finalMessage.content) {
        if (content.type === "tool_use") {
          await streamHandlers.onToolUse(content);
        }
      }
    }

    return finalMessage;
  };

  /**
   * Gets the system prompt content for a given prompt type
   * @param {string} promptType - The prompt type to retrieve
   * @returns {string} The system prompt content
   */
  const getSystemPrompt = (promptType) => {
    return (
      systemPrompts.systemPrompts[promptType]?.content ||
      systemPrompts.systemPrompts[AppConfig.api.defaultPromptType].content
    );
  };

  /**
   * List available Anthropic models (best-effort).
   * @param {object} [params]
   * @param {number} [params.limit] - Max items to retrieve (capped)
   * @returns {Promise<Array<{id:string, display_name?:string, created_at?:string, type?:string}>>}
   */
  const listModels = async (params = {}) => {
    const max = Math.max(1, Math.min(Number(params.limit || 200), 1000));

    // SDK supports pagination; we loop a bit but keep it bounded.
    const out = [];
    let after_id = undefined;

    for (let pages = 0; pages < 10 && out.length < max; pages++) {
      // Some SDK versions expose `anthropic.models.list`.
      if (!anthropic.models || typeof anthropic.models.list !== "function") {
        throw new Error("Anthropic SDK does not support models.list()");
      }

      // eslint-disable-next-line no-await-in-loop
      const resp = await anthropic.models.list({
        limit: Math.min(100, max - out.length),
        after_id,
      });

      const data = Array.isArray(resp?.data) ? resp.data : [];
      for (const m of data) {
        if (m && typeof m.id === "string") out.push(m);
      }

      if (!resp?.has_more) break;
      after_id = resp?.last_id;
      if (!after_id) break;
    }

    // Deduplicate by id (stable ordering)
    const seen = new Set();
    return out.filter((m) => {
      if (!m?.id || seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    });
  };

  return {
    streamConversation,
    getSystemPrompt,
    listModels,
  };
}

export default {
  createClaudeService,
};
