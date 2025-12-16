import { authenticate } from "../shopify.server";
import { assertRequestShopAllowed } from "../utils/shop-allowlist.server";

export const loader = async ({ request }) => {
  assertRequestShopAllowed(request);
  await authenticate.admin(request);

  return null;
};
