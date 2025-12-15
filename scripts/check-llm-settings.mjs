import "dotenv/config";
import prisma from "../app/db.server.js";

function usage() {
  console.log(`Usage:
  node scripts/check-llm-settings.mjs [shopDomain] [expectedLast8]

Examples:
  node scripts/check-llm-settings.mjs
  node scripts/check-llm-settings.mjs dev-gusto.myshopify.com
  node scripts/check-llm-settings.mjs dev-gusto.myshopify.com KEHTpgAA
`);
}

const shop = process.argv[2] || null;
const expectedLast8 = process.argv[3] || null;

if (process.argv.includes("-h") || process.argv.includes("--help")) {
  usage();
  process.exit(0);
}

const rows = await prisma.shopLlmSettings.findMany({
  where: shop ? { shop } : undefined,
  orderBy: { updatedAt: "desc" },
});

if (!rows || rows.length === 0) {
  console.log("No ShopLlmSettings rows found.");
  process.exit(0);
}

for (const r of rows) {
  const encLenAnth = typeof r.anthropicApiKeyEnc === "string" ? r.anthropicApiKeyEnc.length : 0;
  const encLenOai = typeof r.openaiApiKeyEnc === "string" ? r.openaiApiKeyEnc.length : 0;
  const encLenGem = typeof r.geminiApiKeyEnc === "string" ? r.geminiApiKeyEnc.length : 0;

  const hintAnth = typeof r.anthropicApiKeyHint === "string" ? r.anthropicApiKeyHint : "";
  const hintOai = typeof r.openaiApiKeyHint === "string" ? r.openaiApiKeyHint : "";
  const hintGem = typeof r.geminiApiKeyHint === "string" ? r.geminiApiKeyHint : "";

  const hintSuffix = hintAnth ? hintAnth.slice(-8) : "";

  console.log("---");
  console.log("shop:", r.shop);
  console.log("llmProvider:", r.llmProvider);
  console.log("defaultModel:", r.defaultModel || "(null)");
  console.log("anthropicApiKeyEnc:", encLenAnth > 0 ? `(set, ${encLenAnth} chars)` : "(empty)");
  console.log("anthropicApiKeyHint:", hintAnth || "(null)");
  console.log("openaiApiKeyEnc:", encLenOai > 0 ? `(set, ${encLenOai} chars)` : "(empty)");
  console.log("openaiApiKeyHint:", hintOai || "(null)");
  console.log("geminiApiKeyEnc:", encLenGem > 0 ? `(set, ${encLenGem} chars)` : "(empty)");
  console.log("geminiApiKeyHint:", hintGem || "(null)");

  if (expectedLast8) {
    const ok = hintSuffix === expectedLast8;
    console.log("matches expected last8:", ok ? "YES" : "NO");
  }
}

await prisma.$disconnect();
