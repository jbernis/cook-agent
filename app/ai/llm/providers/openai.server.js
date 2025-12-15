/**
 * OpenAI Service (no SDK dependency)
 * - Streams chat completions
 * - Supports function/tool calling
 *
 * Output is normalized to Anthropic-like blocks so the rest of the app can stay unchanged:
 * - text: { type: "text", text }
 * - tool_use: { type: "tool_use", id, name, input }
 */
import AppConfig from "../../../config/app-config.server";
import systemPrompts from "../../../prompts/prompts.json";

const OPENAI_API_BASE = "https://api.openai.com/v1";

function getSystemPrompt(promptType) {
  return (
    systemPrompts.systemPrompts[promptType]?.content ||
    systemPrompts.systemPrompts[AppConfig.api.defaultPromptType].content
  );
}

function toOpenAiTools(tools) {
  const arr = Array.isArray(tools) ? tools : [];
  return arr.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description || "",
      // OpenAI expects JSON Schema for parameters
      parameters: t.input_schema || { type: "object", properties: {} },
    },
  }));
}

function stringifyToolResultContent(content) {
  if (typeof content === "string") return content;
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

/**
 * Convert our internal conversation history (Anthropic-like) to OpenAI messages.
 * @param {Array} history
 * @param {string} systemInstruction
 */
function toOpenAiMessages(history, systemInstruction) {
  const out = [{ role: "system", content: systemInstruction }];
  const msgs = Array.isArray(history) ? history : [];
  const knownToolCallIds = new Set();

  for (const m of msgs) {
    const role = m?.role;
    const content = m?.content;

    if (!role) continue;

    // Plain string content
    if (typeof content === "string") {
      out.push({ role, content });
      continue;
    }

    // Array of blocks (Anthropic content blocks)
    const blocks = Array.isArray(content) ? content : [content].filter(Boolean);
    let textParts = [];
    const toolUses = [];

    for (const b of blocks) {
      if (!b || typeof b !== "object") continue;
      if (b.type === "text" && typeof b.text === "string") {
        textParts.push(b.text);
        continue;
      }

      if (b.type === "tool_use" && b.id && b.name) {
        toolUses.push(b);
        knownToolCallIds.add(b.id);
        continue;
      }

      if (b.type === "tool_result") {
        // OpenAI requires tool messages to directly follow an assistant message with tool_calls.
        // If we don't have a matching prior tool call id (common for server-side auto tool usage),
        // fall back to a user-visible text block instead of role:"tool".
        if (b.tool_use_id && knownToolCallIds.has(b.tool_use_id)) {
          out.push({
            role: "tool",
            tool_call_id: b.tool_use_id,
            content: stringifyToolResultContent(b.content),
          });
        } else {
          textParts.push(`Tool result:\n${stringifyToolResultContent(b.content)}`);
        }
        continue;
      }
    }

    const text = textParts.join("\n").trim();

    if (role === "assistant" && toolUses.length > 0) {
      out.push({
        role: "assistant",
        content: text || null,
        tool_calls: toolUses.map((tu) => ({
          id: tu.id,
          type: "function",
          function: {
            name: tu.name,
            arguments: JSON.stringify(tu.input || {}),
          },
        })),
      });
      continue;
    }

    if (text) out.push({ role, content: text });
  }

  return out;
}

export function createOpenAiService(apiKey = process.env.OPENAI_API_KEY) {
  if (!apiKey) throw new Error("Missing OpenAI API key");

  /**
   * Stream conversation, normalize result to Anthropic-like message blocks.
   */
  const streamConversation = async (
    { messages, promptType = AppConfig.api.defaultPromptType, model, tools },
    streamHandlers = {}
  ) => {
    const systemInstruction = getSystemPrompt(promptType);
    const openaiMessages = toOpenAiMessages(messages, systemInstruction);
    const openaiTools = toOpenAiTools(tools);

    const chosenModel =
      typeof model === "string" && model.trim().length > 0
        ? model.trim()
        : AppConfig.api.defaultModels?.openai || "gpt-4o-mini";

    const body = {
      model: chosenModel,
      messages: openaiMessages,
      stream: true,
    };

    if (openaiTools.length > 0) {
      body.tools = openaiTools;
      body.tool_choice = "auto";
    }

    const resp = await fetch(`${OPENAI_API_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok || !resp.body) {
      const text = await resp.text().catch(() => "");
      throw new Error(`OpenAI request failed: ${resp.status} ${text}`.trim());
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    let fullText = "";
    // tool_calls come in fragments; we assemble by index
    const toolCalls = new Map(); // index -> { id, name, args }
    let finishReason = null;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const parts = buffer.split("\n\n");
      buffer = parts.pop() || "";

      for (const part of parts) {
        const lines = part.split("\n");
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const payload = trimmed.slice(5).trim();
          if (payload === "[DONE]") {
            finishReason = finishReason || "stop";
            continue;
          }
          let json;
          try {
            json = JSON.parse(payload);
          } catch {
            continue;
          }

          const choice = json?.choices?.[0];
          const delta = choice?.delta;
          if (choice?.finish_reason) finishReason = choice.finish_reason;

          const contentDelta = delta?.content;
          if (typeof contentDelta === "string" && contentDelta.length > 0) {
            fullText += contentDelta;
            streamHandlers.onText?.(contentDelta);
          }

          const toolDelta = Array.isArray(delta?.tool_calls) ? delta.tool_calls : [];
          for (const tc of toolDelta) {
            const idx = typeof tc.index === "number" ? tc.index : 0;
            const current = toolCalls.get(idx) || {
              id: tc.id || null,
              name: "",
              args: "",
            };
            if (tc.id) current.id = tc.id;
            const fn = tc.function || {};
            if (typeof fn.name === "string") current.name = fn.name;
            if (typeof fn.arguments === "string") current.args += fn.arguments;
            toolCalls.set(idx, current);
          }
        }
      }
    }

    // Build normalized content blocks
    const blocks = [];
    const text = fullText.trim();
    if (text) blocks.push({ type: "text", text });

    const sortedToolCalls = Array.from(toolCalls.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => v);
    for (const tc of sortedToolCalls) {
      if (!tc?.name || !tc?.id) continue;
      let input = {};
      try {
        input = tc.args ? JSON.parse(tc.args) : {};
      } catch {
        // Best-effort: keep raw string in a field so tool handlers can still use it
        input = { _raw: tc.args || "" };
      }
      blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input });
    }

    const finalMessage = {
      role: "assistant",
      content: blocks,
      stop_reason: finishReason === "tool_calls" ? "tool_use" : "end_turn",
    };

    // Mimic Claude service: call onMessage, then run tool handlers
    streamHandlers.onMessage?.(finalMessage);
    if (streamHandlers.onToolUse) {
      for (const b of blocks) {
        if (b.type === "tool_use") {
          // eslint-disable-next-line no-await-in-loop
          await streamHandlers.onToolUse(b);
        }
      }
    }

    return finalMessage;
  };

  /**
   * List OpenAI models (best-effort).
   * @returns {Promise<Array<{id:string, display_name?:string}>>}
   */
  const listModels = async () => {
    const resp = await fetch(`${OPENAI_API_BASE}/models`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`OpenAI models list failed: ${resp.status} ${text}`.trim());
    }
    const json = await resp.json();
    const data = Array.isArray(json?.data) ? json.data : [];
    return data
      .filter((m) => m && typeof m.id === "string")
      .map((m) => ({ id: m.id, display_name: m.id }));
  };

  return { streamConversation, listModels };
}
