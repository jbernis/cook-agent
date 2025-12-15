import { login } from "../shopify.server";

// This route must call `login()` (NOT authenticate.admin()).
// Shopify will hit /auth/login as the configured login path.
export const loader = async ({ request }) => {
  return login(request);
};

