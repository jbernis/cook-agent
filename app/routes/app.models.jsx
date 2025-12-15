import { authenticate } from "../shopify.server";
import { getShopLlmSettings } from "../ai/shop-llm-settings.server";
import AppConfig from "../config/app-config.server";
import { createLlmService, defaultModelForProvider } from "../ai/llm/factory.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session?.shop;

  if (!shop) {
    return new Response(JSON.stringify({ error: "Missing shop" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const url = new URL(request.url);
  const provider = String(url.searchParams.get("provider") || "anthropic").trim() || "anthropic";
  const selectedModelParam = String(url.searchParams.get("selectedModel") || "").trim();
  console.log("[app.models] request", { shop, provider });
  if (!["anthropic", "openai", "gemini"].includes(provider)) {
    return new Response(JSON.stringify({ error: `Unsupported provider: ${provider}` }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const settings = await getShopLlmSettings(shop);
  const key =
    provider === "anthropic"
      ? (settings?.anthropicApiKey || process.env.CLAUDE_API_KEY || "")
      : provider === "openai"
        ? (settings?.openaiApiKey || process.env.OPENAI_API_KEY || "")
        : (settings?.geminiApiKey || process.env.GEMINI_API_KEY || "");
  if (!key) {
    const name =
      provider === "anthropic" ? "Anthropic" :
        provider === "openai" ? "OpenAI" : "Gemini";
    console.log("[app.models] missing api key", { shop, provider });
    return new Response(
      JSON.stringify({ error: `No ${name} API key configured. Set it in Settings first.` }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  try {
    const llm = createLlmService(provider, key);
    const models = await llm.listModels({ limit: 200 });
    console.log("[app.models] response", { shop, provider, count: Array.isArray(models) ? models.length : 0 });

    const simplified = models
      .filter((m) => m && typeof m.id === "string")
      .map((m) => ({ id: m.id, display_name: m.display_name || m.id }));

    // Always include our server default
    const ensure = (id) => {
      if (!id) return;
      if (!simplified.some((m) => m.id === id)) simplified.unshift({ id, display_name: id });
    };
    ensure(defaultModelForProvider(provider));
    // Avoid mixing models across providers: only include the caller's selectedModel (or the shop's default when provider matches).
    if (selectedModelParam) ensure(selectedModelParam);
    else if (settings?.llmProvider === provider) ensure(settings?.defaultModel);

    return new Response(JSON.stringify({ models: simplified }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    console.log("[app.models] error", { shop, provider, message: e?.message || String(e) });
    return new Response(JSON.stringify({ error: e?.message || String(e) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};

