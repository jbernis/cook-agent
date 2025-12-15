import AppConfig from "../../config/app-config.server";
import { createClaudeService } from "./providers/anthropic.server";
import { createOpenAiService } from "./providers/openai.server";
import { createGeminiService } from "./providers/gemini.server";

/**
 * @param {"anthropic"|"openai"|"gemini"} provider
 * @param {string} apiKey
 */
export function createLlmService(provider, apiKey) {
  const p = typeof provider === "string" && provider.trim() ? provider.trim() : "anthropic";
  if (p === "anthropic") return createClaudeService(apiKey);
  if (p === "openai") return createOpenAiService(apiKey);
  if (p === "gemini") return createGeminiService(apiKey);
  throw new Error(`Unsupported llm_provider: ${p}`);
}

export function defaultModelForProvider(provider) {
  const p = typeof provider === "string" && provider.trim() ? provider.trim() : "anthropic";
  return AppConfig.api.defaultModels?.[p] || AppConfig.api.defaultModel;
}

import AppConfig from "../../config/app-config.server";
import { createClaudeService } from "./providers/anthropic.server";
import { createOpenAiService } from "./providers/openai.server";
import { createGeminiService } from "./providers/gemini.server";

/**
 * @param {"anthropic"|"openai"|"gemini"} provider
 * @param {string} apiKey
 */
export function createLlmService(provider, apiKey) {
  const p =
    typeof provider === "string" && provider.trim() ? provider.trim() : "anthropic";
  if (p === "anthropic") return createClaudeService(apiKey);
  if (p === "openai") return createOpenAiService(apiKey);
  if (p === "gemini") return createGeminiService(apiKey);
  throw new Error(`Unsupported llm_provider: ${p}`);
}

export function defaultModelForProvider(provider) {
  const p =
    typeof provider === "string" && provider.trim() ? provider.trim() : "anthropic";
  return AppConfig.api.defaultModels?.[p] || AppConfig.api.defaultModel;
}


