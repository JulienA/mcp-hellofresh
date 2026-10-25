import { AccountStore } from "./accounts.js";
import { type FetchLike } from "./hellofresh-api.js";
export interface AccountLinker {
    linkWithPassword(input: {
        country: string;
        email: string;
        password: string;
    }): Promise<{
        userId: string;
    }>;
    linkWithToken(input: {
        country: string;
        token: string;
    }): Promise<{
        userId: string;
    }>;
}
export declare function createAccountLinker(store: AccountStore, fetchImpl?: FetchLike): AccountLinker;
//# sourceMappingURL=account-linker.d.ts.map