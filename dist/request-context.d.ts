import { AsyncLocalStorage } from "node:async_hooks";
/** HelloFresh user id for the /mcp request currently being handled. */
export declare const helloFreshUserContext: AsyncLocalStorage<string>;
export declare function currentHelloFreshUserId(): string | undefined;
//# sourceMappingURL=request-context.d.ts.map