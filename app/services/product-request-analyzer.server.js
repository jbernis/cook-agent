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
 *  adjectives: string[],
 *  definition: string
 * }} ProductRequestSummaryItem
 */

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
  ["assiette", "tableware"],
  ["assiettes", "tableware"],
  ["bol", "tableware"],
  ["bols", "tableware"],
  ["tasse", "tableware"],
  ["tasses", "tableware"],
  ["verre", "glassware"],
  ["verres", "glassware"],
  // Cookware
  ["casserole", "cookware"],
  ["casseroles", "cookware"],
  ["poêle", "cookware"],
  ["poele", "cookware"],
  ["poêles", "cookware"],
  ["poeles", "cookware"],
  // Cutlery
  ["couteau", "cutlery"],
  ["couteaux", "cutlery"],
  ["fourchette", "cutlery"],
  ["fourchettes", "cutlery"],
  ["cuillère", "cutlery"],
  ["cuilleres", "cutlery"],
  ["cuillères", "cutlery"],
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

function looksLikeProductIntent(text) {
  const lower = (text || "").toLowerCase();
  const hasIntentVerb = INTENT_VERBS.some((v) => new RegExp(`\\b${escapeRegex(v)}\\b`, "i").test(lower));
  if (hasIntentVerb) return true;

  // If user just types a product name ("assiettes plates"), treat as a product request.
  const tokens = tokenize(lower);
  const hasKnownProductToken = tokens.some((t) => KNOWN_PRODUCT_TOKENS.has(t));
  if (hasKnownProductToken) return true;

  // Short product-only queries ("assiettes plates"): be conservative to avoid classifying generic questions.
  const meaningful = tokens.filter((t) => t && !STOPWORDS.has(t));
  if (meaningful.some((t) => NON_PRODUCT_TOPICS.has(t))) return false;
  if (meaningful.length >= 1 && meaningful.length <= 3) {
    if (WH_WORDS.has(meaningful[0])) return false;
    return true;
  }

  return false;
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

function getCategory(productToken) {
  if (!productToken) return "product";
  return PRODUCT_TO_CATEGORY.get(productToken.toLowerCase()) || "product";
}

function getDefinition(productToken) {
  const p = (productToken || "").trim();
  if (!p) return "";

  // A neutral, non-specific definition; keep it short and not attribute extra traits.
  if (/^(assiette|assiettes)$/i.test(p)) return "A plate is an item used to serve food.";
  if (/^(bol|bols)$/i.test(p)) return "A bowl is a container used to hold food.";
  if (/^(tasse|tasses)$/i.test(p)) return "A cup is a small vessel used to drink beverages.";
  if (/^(verre|verres)$/i.test(p)) return "A glass is a vessel used to drink beverages.";
  if (/^(casserole|casseroles)$/i.test(p)) return "A saucepan is cookware used to heat or cook food.";
  if (/^(poêle|poele|poêles|poeles)$/i.test(p)) return "A frying pan is cookware used to cook food on a stovetop.";
  if (/^(couteau|couteaux)$/i.test(p)) return "A knife is a utensil used to cut food.";
  if (/^(fourchette|fourchettes)$/i.test(p)) return "A fork is a utensil used to pick up food.";
  if (/^(cuillère|cuilleres|cuillères)$/i.test(p)) return "A spoon is a utensil used to scoop or stir food.";

  return `A ${p} is a product.`;
}

function analyzeDeterministically(text) {
  const input = normalizeText(text);
  if (!input) return [];

  // If there's no shopping/product intent, return [] so the main LLM flow can proceed.
  // (We still ran the analyzer, satisfying the “use analysis tool” requirement.)
  if (!looksLikeProductIntent(input)) return [];

  const segments = splitProductSegments(input);
  const items = [];
  const adjectives = extractAdjectivesFromText(input);

  for (const seg of segments) {
    const product = extractCandidateProductToken(seg);
    if (!product) continue;

    items.push({
      product,
      category: getCategory(product),
      adjectives,
      definition: getDefinition(product),
    });
  }

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
  return Array.isArray(out?.summary) ? out.summary : [];
}

export default {
  analyzeCustomerProductRequest,
};

