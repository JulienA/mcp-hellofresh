import { AccountStore, parseApiV2Auth } from "./accounts.js";
import { HelloFreshApi, type FetchLike } from "./hellofresh-api.js";

export interface AccountLinker {
  linkWithPassword(input: { country: string; email: string; password: string }): Promise<{ userId: string }>;
  linkWithToken(input: { country: string; token: string }): Promise<{ userId: string }>;
}

export function createAccountLinker(store: AccountStore, fetchImpl: FetchLike = fetch): AccountLinker {
  return {
    async linkWithPassword(input) {
      const api = await HelloFreshApi.login({ ...input, fetchImpl });
      const stored = api.toStoredAccount();
      await store.save(stored);
      return { userId: stored.userId };
    },
    async linkWithToken(input) {
      const parsed = parseApiV2Auth(input.token);
      const api = await HelloFreshApi.fromPasted({
        token: input.token,
        country: input.country,
        fetchImpl,
        parsed,
      });
      const stored = api.toStoredAccount();
      await store.save(stored);
      return { userId: stored.userId };
    },
  };
}
