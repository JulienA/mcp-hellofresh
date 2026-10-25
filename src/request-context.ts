import { AsyncLocalStorage } from "node:async_hooks";

/** HelloFresh user id for the /mcp request currently being handled. */
export const helloFreshUserContext = new AsyncLocalStorage<string>();

export function currentHelloFreshUserId(): string | undefined {
  return helloFreshUserContext.getStore();
}
