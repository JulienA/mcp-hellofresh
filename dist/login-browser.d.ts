import { type FetchLike } from "./hellofresh-api.js";
import type { StoredAccount } from "./accounts.js";
/**
 * Opens HelloFresh in a local window so the person can finish Google sign-in
 * themselves. Only the apiV2Auth token is kept. The Google password is never read.
 */
export declare function captureHelloFreshAccount(input: {
    country: string;
    fetchImpl?: FetchLike;
    loginTimeoutMs?: number;
}): Promise<StoredAccount>;
//# sourceMappingURL=login-browser.d.ts.map