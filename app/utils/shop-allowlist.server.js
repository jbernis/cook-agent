const DEFAULT_ALLOWED_SHOPS = ["mon-shop.myshopify.com"];

function parseAllowedShopsEnv(value) {
  if (!value) return null;
  return value
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function getAllowedShops() {
  // Optional override: set SHOPIFY_ALLOWED_SHOPS="a.myshopify.com,b.myshopify.com"
  const fromEnv = parseAllowedShopsEnv(process.env.SHOPIFY_ALLOWED_SHOPS);
  return fromEnv ?? DEFAULT_ALLOWED_SHOPS;
}

export function getShopFromRequest(request) {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");
  return shop ? shop.trim().toLowerCase() : "";
}

export function assertRequestShopAllowed(request) {
  const shop = getShopFromRequest(request);
  const allowed = getAllowedShops();

  // If you explicitly want "no restriction", set SHOPIFY_ALLOWED_SHOPS="" and
  // change DEFAULT_ALLOWED_SHOPS to [] (or update this behavior).
  if (!shop || !allowed.includes(shop)) {
    throw new Response("Cette application n'est pas disponible pour ce magasin.", {
      status: 403,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
}


