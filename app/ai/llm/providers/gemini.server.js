/**
 * Gemini Service (Google AI Studio / Generative Language API, no SDK dependency)
 * - Non-streaming generateContent (we emit one onText chunk)
 * - Supports function/tool calling (best-effort)
 *
 * Output normalized to Anthropic-like blocks:
 * - text: { type: "text", text }
 * - tool_use: { type: "tool_use", id, name, input }
 */
import AppConfig from "../../../config/app-config.server";
import systemPrompts from "../../../prompts/prompts.json";

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";

function getSystemPrompt(promptType) {
  return (
    systemPrompts.systemPrompts[promptType]?.content ||
    systemPrompts.systemPrompts[AppConfig.api.defaultPromptType].content
  );
}

function toGeminiFunctionDeclarations(tools) {
  const arr = Array.isArray(tools) ? tools : [];
  return arr.map((t) => ({
    name: t.name,
    description: t.description || "",
    // The API accepts JSON Schema-like parameters. Keep what we already have.
    parameters: t.input_schema || { type: "object", properties: {} },
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
 * Convert our internal history to Gemini "contents".
 * We map:
 * - user/assistant text → parts: [{text}]
 * - tool_result blocks → parts: [{functionResponse: { name, response: { content }}}]
 *
 * NOTE: For proper functionResponse we need the tool name stored on tool_result blocks.
 * If missing, we fall back to a text part that includes the tool output.
 */
function toGeminiContents(history) {
  const out = [];
  const msgs = Array.isArray(history) ? history : [];

  for (const m of msgs) {
    const role = m?.role === "assistant" ? "model" : "user";
    const content = m?.content;

    if (typeof content === "string") {
      out.push({ role, parts: [{ text: content }] });
      continue;
    }

    const blocks = Array.isArray(content) ? content : [content].filter(Boolean);
    let textParts = [];
    const parts = [];

    for (const b of blocks) {
      if (!b || typeof b !== "object") continue;
      if (b.type === "text" && typeof b.text === "string") {
        textParts.push(b.text);
        continue;
      }

      if (b.type === "tool_result") {
        const toolName =
          typeof b.tool_name === "string"
            ? b.tool_name
            : typeof b.name === "string"
              ? b.name
              : null;
        const toolText = stringifyToolResultContent(b.content);

        if (toolName) {
          parts.push({
            functionResponse: {
              name: toolName,
              response: { content: toolText },
            },
          });
        } else {
          // Fallback: keep tool result as plain text so the model can see it.
          textParts.push(`Tool result:\n${toolText}`);
        }
      }
    }

    const text = textParts.join("\n").trim();
    if (text) parts.unshift({ text });
    if (parts.length > 0) out.push({ role, parts });
  }

  return out;
}

export function createGeminiService(apiKey = process.env.GEMINI_API_KEY) {
  if (!apiKey) throw new Error("Missing Gemini API key");

  const streamConversation = async (
    { messages, promptType = AppConfig.api.defaultPromptType, model, tools },
    streamHandlers = {}
  ) => {
    const systemInstruction = getSystemPrompt(promptType);
    const chosenModel =
      typeof model === "string" && model.trim().length > 0
        ? model.trim()
        : AppConfig.api.defaultModels?.gemini || "gemini-1.5-flash";

    const contents = toGeminiContents(messages);
    const functionDeclarations = toGeminiFunctionDeclarations(tools);

    const body = {
      contents,
      system_instruction: { parts: [{ text: systemInstruction }] },
    };

    if (functionDeclarations.length > 0) {
      body.tools = [{ functionDeclarations }];
      body.toolConfig = { functionCallingConfig: { mode: "AUTO" } };
    }

    const resp = await fetch(
      `${GEMINI_API_BASE}/models/${encodeURIComponent(
        chosenModel
      )}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Gemini request failed: ${resp.status} ${text}`.trim());
    }

    const json = await resp.json();
    const candidate = json?.candidates?.[0];
    const parts = Array.isArray(candidate?.content?.parts)
      ? candidate.content.parts
      : [];

    const blocks = [];
    let textOut = "";
    let toolUses = [];

    for (const p of parts) {
      if (typeof p?.text === "string") {
        textOut += p.text;
      }
      if (p?.functionCall && typeof p.functionCall.name === "string") {
        toolUses.push(p.functionCall);
      }
    }

    const trimmed = textOut.trim();
    if (trimmed) {
      blocks.push({ type: "text", text: trimmed });
      streamHandlers.onText?.(trimmed);
    }

    for (const fc of toolUses) {
      const id = `gemini_${Date.now()}_${Math.random()
        .toString(16)
        .slice(2)}`;
      blocks.push({
        type: "tool_use",
        id,
        name: fc.name,
        input: fc.args || {},
      });
    }

    const finalMessage = {
      role: "assistant",
      content: blocks,
      stop_reason: toolUses.length > 0 ? "tool_use" : "end_turn",
    };

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

  const listModels = async () => {
    const resp = await fetch(
      `${GEMINI_API_BASE}/models?key=${encodeURIComponent(apiKey)}`,
      {
        method: "GET",
        headers: { Accept: "application/json" },
      }
    );
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Gemini models list failed: ${resp.status} ${text}`.trim());
    }
    const json = await resp.json();
    const models = Array.isArray(json?.models) ? json.models : [];
    return models
      .filter((m) => m && typeof m.name === "string")
      .map((m) => {
        const id = m.name.replace(/^models\//, "");
        return { id, display_name: id };
      });
  };

  return { streamConversation, listModels };
}
