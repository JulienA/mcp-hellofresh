import { AsyncLocalStorage } from "node:async_hooks";
export interface RequestLogStore {
    requestId: string;
}
/** Correlation id for the HTTP request currently being handled. */
export declare const requestLogContext: AsyncLocalStorage<RequestLogStore>;
export declare function currentRequestId(): string | undefined;
/** HelloFresh user id for the /mcp request currently being handled. */
export declare const helloFreshUserContext: AsyncLocalStorage<string>;
export declare function currentHelloFreshUserId(): string | undefined;
//# sourceMappingURL=request-context.d.ts.map