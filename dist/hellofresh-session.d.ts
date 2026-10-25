import { type AccountStore } from "./accounts.js";
import { HelloFreshApi, type AccountStatus, type FetchLike } from "./hellofresh-api.js";
export declare const STDIO_RECONNECT_MESSAGE = "No HelloFresh account is saved on this machine. Run `npm run login` and finish Continue with Google in the window, or set HELLOFRESH_EMAIL and HELLOFRESH_PASSWORD for a HelloFresh password account. Do not send a Google password.";
export interface HelloFreshSession {
    status(): Promise<AccountStatus>;
    logout(): Promise<void>;
    api(): Promise<HelloFreshApi>;
    login?(): Promise<{
        savedAt: string;
        email: string;
        country: string;
    }>;
}
export declare class AccountClients {
    private readonly store;
    private readonly fetchImpl;
    private readonly clients;
    constructor(store: AccountStore, fetchImpl?: FetchLike);
    sessionFor(userId: string): HelloFreshSession;
    private clientFor;
}
export declare function createStdioSession(env?: NodeJS.ProcessEnv, fetchImpl?: FetchLike): HelloFreshSession;
//# sourceMappingURL=hellofresh-session.d.ts.map