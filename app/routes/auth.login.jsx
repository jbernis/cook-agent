import { login } from "../shopify.server";
import { assertRequestShopAllowed } from "../utils/shop-allowlist.server";

// This route must call `login()` (NOT authenticate.admin()).
// Shopify will hit /auth/login as the configured login path.
export const loader = async ({ request }) => {
  assertRequestShopAllowed(request);
  return login(request);
};

