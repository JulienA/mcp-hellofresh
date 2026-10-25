import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestLogStore {
  requestId: string;
}

/** Correlation id for the HTTP request currently being handled. */
export const requestLogContext = new AsyncLocalStorage<RequestLogStore>();

export function currentRequestId(): string | undefined {
  return requestLogContext.getStore()?.requestId;
}

/** HelloFresh user id for the /mcp request currently being handled. */
export const helloFreshUserContext = new AsyncLocalStorage<string>();

export function currentHelloFreshUserId(): string | undefined {
  return helloFreshUserContext.getStore();
}
