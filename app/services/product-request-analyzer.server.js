/**
 * Product Request Analyzer (deterministic)
 *
 * Implemented as a LangGraph workflow node so we can evolve the graph over time.
 * This analyzer intentionally avoids "creative" inference:
 * - product: single main noun
 * - adjectives: only extracted if explicitly present in the text
 * - category/definition: simple and neutral
 */
import { END, StateGraph } from "@langchain/langgraph";

/**
 * @typedef {{
 *  product: string,
 *  category: string,
 *  characteristics: string[],
 *  definition: string
 * }} ProductRequestSummaryItem
 */

const PRODUCT_WORKFLOW_DEBUG =
  process.env.PRODUCT_WORKFLOW_DEBUG === "1" ||
  process.env.PRODUCT_WORKFLOW_DEBUG === "true";

function debugLog(...args) {
  if (!PRODUCT_WORKFLOW_DEBUG) return;
  console.log("[product-workflow][analyzer]", ...args);
}

const STOPWORDS = new Set([
  // FR articles / pronouns / helpers
  "je", "j", "tu", "il", "elle", "on", "nous", "vous", "ils", "elles",
  "me", "m", "te", "t", "se", "s", "mon", "ma", "mes", "ton", "ta", "tes", "son", "sa", "ses", "notre", "nos", "votre", "vos", "leur", "leurs",
  "un", "une", "des", "du", "de", "d", "la", "le", "les", "l",
  "à", "a", "au", "aux", "en", "dans", "sur", "sous", "avec", "sans", "pour", "par", "chez",
  "ce", "cet", "cette", "ces", "ça", "c", "ici", "là",
  // EN determiners / pronouns / helpers
  "i", "im", "i'm", "me", "my", "mine", "you", "your", "yours", "we", "our", "ours", "they", "their", "theirs",
  "a", "an", "the", "some", "any", "this", "that", "these", "those",
  "to", "for", "of", "in", "on", "with", "without", "from", "at", "by",
  // greetings / fillers
  "bonjour", "salut", "hello", "hi", "merci", "thanks", "svp", "stp", "please",
]);

const INTENT_VERBS = [
  // FR
  "cherche", "recherche", "voudrais", "aimerais", "veux", "souhaite", "besoin", "trouve", "montre", "montrez", "voir",
  // EN
  "looking", "searching", "need", "want", "find", "show",
];

const KNOWN_DESCRIPTOR_PHRASES = [
  // FR common refinements
  "à dessert",
  "a dessert",
  "à gateau",
  "a gateau",
  "à gâteau",
  "a gâteau",
  "à fromage",
  "a fromage",
  "sans fil",
  "sans gluten",
  "sans sucre",
  "antiadhésif",
  "anti-adhésif",
  "inox",
  "acier",
  "bois",
  "verre",
  "plastique",
  "céramique",
  "ceramique",
  "petit",
  "petite",
  "petits",
  "petites",
  "moyen",
  "moyenne",
  "moyens",
  "moyennes",
  "grand",
  "grande",
  "grands",
  "grandes",
  "plate",
  "plates",
  "creuse",
  "creuses",
  // EN
  "wireless",
  "stainless",
  "stainless steel",
  "non stick",
  "non-stick",
  "small",
  "medium",
  "large",
  "red",
  "blue",
  "green",
  "black",
  "white",
];

const PRODUCT_TO_CATEGORY = new Map([
  // Tableware
  ["assiette", "vaisselle"],
  ["assiettes", "vaisselle"],
  ["bol", "vaisselle"],
  ["bols", "vaisselle"],
  ["tasse", "vaisselle"],
  ["tasses", "vaisselle"],
  ["verre", "verrerie"],
  ["verres", "verrerie"],
  // Cookware
  ["casserole", "ustensiles de cuisine"],
  ["casseroles", "ustensiles de cuisine"],
  ["poêle", "ustensiles de cuisine"],
  ["poele", "ustensiles de cuisine"],
  ["poêles", "ustensiles de cuisine"],
  ["poeles", "ustensiles de cuisine"],
  // Cutlery
  ["couteau", "couverts"],
  ["couteaux", "couverts"],
  ["fourchette", "couverts"],
  ["fourchettes", "couverts"],
  ["cuillère", "couverts"],
  ["cuilleres", "couverts"],
  ["cuillères", "couverts"],
]);

const KNOWN_PRODUCT_TOKENS = new Set(Array.from(PRODUCT_TO_CATEGORY.keys()));
const WH_WORDS = new Set([
  "what", "why", "how", "where", "when", "which",
  "quel", "quelle", "quels", "quelles", "comment", "pourquoi", "où", "ou", "quand",
]);

const NON_PRODUCT_TOPICS = new Set([
  // EN
  "order", "orders", "status", "shipping", "delivery", "refund", "return", "returns",
  "invoice", "payment", "account", "login", "password", "support", "help",
  // FR
  "commande", "commandes", "statut", "livraison", "expedition", "expédition",
  "remboursement", "retour", "retours", "facture", "paiement", "compte", "connexion",
  "aide", "support",
]);

function normalizeText(s) {
  return (s || "")
    .replace(/[\u2019']/g, "'")
    .replace(/[(){}[\],.;:!?/\\|<>"]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(s) {
  const cleaned = normalizeText(s).toLowerCase();
  // Keep accented letters; split on whitespace
  return cleaned.split(/\s+/g).filter(Boolean);
}

function getProductIntentDecision(text) {
  const lower = (text || "").toLowerCase();
  const tokens = tokenize(lower);

  const hasIntentVerb = INTENT_VERBS.some((v) => new RegExp(`\\b${escapeRegex(v)}\\b`, "i").test(lower));
  const hasKnownProductToken = tokens.some((t) => KNOWN_PRODUCT_TOKENS.has(t));
  const meaningful = tokens.filter((t) => t && !STOPWORDS.has(t));

  const hasNonProductTopic = meaningful.some((t) => NON_PRODUCT_TOPICS.has(t));
  const startsWithWhWord = meaningful.length > 0 && WH_WORDS.has(meaningful[0]);
  const isShortQuery = meaningful.length >= 1 && meaningful.length <= 3;

  // Decision order mirrors the boolean logic
  if (hasIntentVerb) return { isProductIntent: true, reason: "intent_verb", tokens, meaningful };
  if (hasKnownProductToken) return { isProductIntent: true, reason: "known_product_token", tokens, meaningful };
  if (hasNonProductTopic) return { isProductIntent: false, reason: "non_product_topic", tokens, meaningful };
  if (isShortQuery && startsWithWhWord) return { isProductIntent: false, reason: "wh_word_question", tokens, meaningful };
  if (isShortQuery) return { isProductIntent: true, reason: "short_query", tokens, meaningful };

  return { isProductIntent: false, reason: "no_signal", tokens, meaningful };
}

function looksLikeProductIntent(text) {
  return getProductIntentDecision(text).isProductIntent;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function splitProductSegments(text) {
  // Try to split on "et/and/," to allow multiple products.
  // We keep it conservative: only split on separators with spaces to avoid breaking words.
  return normalizeText(text)
    .split(/\s+(?:et|and)\s+|,/i)
    .map((p) => p.trim())
    .filter(Boolean);
}

function extractCandidateProductToken(segment) {
  const tokens = tokenize(segment);
  if (tokens.length === 0) return null;

  // If the segment contains an intent verb, start scanning after it (best-effort).
  let startIdx = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (INTENT_VERBS.includes(tokens[i])) {
      startIdx = i + 1;
      break;
    }
  }

  for (let i = startIdx; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t) continue;
    if (STOPWORDS.has(t)) continue;
    // Skip obvious adjectives if they appear first in a fragment like "petite"
    if (KNOWN_DESCRIPTOR_PHRASES.includes(t)) continue;
    // Single main noun = first acceptable token
    return t;
  }

  return null;
}

function extractAdjectivesFromText(text) {
  const lower = normalizeText(text).toLowerCase();
  const found = new Set();

  // Phrase matches first (multi-word)
  for (const phrase of KNOWN_DESCRIPTOR_PHRASES.filter((p) => p.includes(" "))) {
    if (lower.includes(phrase)) found.add(phrase);
  }

  // Token matches (single word)
  const tokens = tokenize(lower);
  for (const t of tokens) {
    if (KNOWN_DESCRIPTOR_PHRASES.includes(t)) found.add(t);
  }

  return Array.from(found);
}

function extractCharacteristicsFromText(text) {
  const lower = normalizeText(text).toLowerCase();
  const found = new Set();

  // 1) Known phrases/tokens (legacy list, still useful)
  for (const phrase of KNOWN_DESCRIPTOR_PHRASES.filter((p) => p.includes(" "))) {
    if (lower.includes(phrase)) found.add(phrase);
  }

  const tokens = tokenize(lower);
  for (const t of tokens) {
    if (KNOWN_DESCRIPTOR_PHRASES.includes(t)) found.add(t);
  }

  // 2) Generic French “à X” / “a X” characteristic extraction (single-word X).
  // We keep it conservative to comply with "never add words not present".
  for (const m of lower.matchAll(/\b(?:à|a)\s+([a-zàâçéèêëîïôûùüÿñæœ-]+)\b/gi)) {
    const word = (m?.[1] || "").trim();
    if (!word) continue;
    found.add(`à ${word}`);
  }

  return Array.from(found);
}

function getCategory(productToken) {
  if (!productToken) return "produit";
  return PRODUCT_TO_CATEGORY.get(productToken.toLowerCase()) || "produit";
}

function getDefinition(productToken, characteristics = []) {
  const p = (productToken || "").trim();
  if (!p) return "";

  // A neutral, non-specific definition; keep it short and not attribute extra traits.
  if (/^(assiette|assiettes)$/i.test(p)) return "Une assiette est un objet utilisé pour servir des aliments.";
  if (/^(bol|bols)$/i.test(p)) return "Un bol est un récipient utilisé pour contenir des aliments.";
  if (/^(tasse|tasses)$/i.test(p)) return "Une tasse est un récipient utilisé pour boire des boissons.";
  if (/^(verre|verres)$/i.test(p)) return "Un verre est un récipient utilisé pour boire des boissons.";
  if (/^(casserole|casseroles)$/i.test(p)) return "Une casserole est un ustensile de cuisine utilisé pour chauffer ou cuire des aliments.";
  if (/^(poêle|poele|poêles|poeles)$/i.test(p)) return "Une poêle est un ustensile de cuisine utilisé pour cuire des aliments sur une plaque.";
  if (/^(couteau|couteaux)$/i.test(p)) {
    const chars = new Set((Array.isArray(characteristics) ? characteristics : []).map((c) => String(c).toLowerCase()));
    // If user explicitly said "à fromage", define it as a cheese knife (still only using user-provided words).
    if (chars.has("à fromage") || chars.has("fromage")) {
      return "Un couteau à fromage est un ustensile utilisé pour couper du fromage.";
    }
    return "Un couteau est un ustensile utilisé pour couper des aliments.";
  }
  if (/^(fourchette|fourchettes)$/i.test(p)) return "Une fourchette est un ustensile utilisé pour piquer des aliments.";
  if (/^(cuillère|cuilleres|cuillères)$/i.test(p)) return "Une cuillère est un ustensile utilisé pour prendre ou mélanger des aliments.";

  return `Un(e) ${p} est un produit.`;
}

function analyzeDeterministically(text) {
  const input = normalizeText(text);
  if (!input) return [];

  // If there's no shopping/product intent, return [] so the main LLM flow can proceed.
  // (We still ran the analyzer, satisfying the “use analysis tool” requirement.)
  const decision = getProductIntentDecision(input);
  debugLog("intent_check", {
    input,
    isProductIntent: decision.isProductIntent,
    reason: decision.reason,
    tokens: decision.tokens,
    meaningful: decision.meaningful,
  });
  if (!decision.isProductIntent) return [];

  const segments = splitProductSegments(input);
  const items = [];
  const characteristics = extractCharacteristicsFromText(input);

  debugLog("extracted_characteristics", characteristics);

  for (const seg of segments) {
    const product = extractCandidateProductToken(seg);
    if (!product) continue;

    items.push({
      product,
      category: getCategory(product),
      characteristics,
      definition: getDefinition(product, characteristics),
    });
  }

  debugLog("extracted_products", items.map((i) => i.product));

  // Deduplicate by product token (keep first)
  const seen = new Set();
  return items.filter((it) => {
    const key = it.product.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * LangGraph wrapper around the deterministic analyzer.
 * @param {string} text
 * @returns {Promise<ProductRequestSummaryItem[]>}
 */
export async function analyzeCustomerProductRequest(text) {
  debugLog("invoke", { text: normalizeText(text) });
  const graph = new StateGraph({
    channels: {
      text: { value: "" },
      summary: { value: [] },
    },
  });

  graph.addNode("analyze", async (state) => {
    return { summary: analyzeDeterministically(state.text) };
  });

  graph.setEntryPoint("analyze");
  graph.addEdge("analyze", END);

  const app = graph.compile();
  const out = await app.invoke({ text });
  const summary = Array.isArray(out?.summary) ? out.summary : [];
  debugLog("result", { summaryLen: summary.length, summary });
  return summary;
}

export default {
  analyzeCustomerProductRequest,
};

