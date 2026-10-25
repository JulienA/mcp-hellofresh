"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.helloFreshUserContext = exports.requestLogContext = void 0;
exports.currentRequestId = currentRequestId;
exports.currentHelloFreshUserId = currentHelloFreshUserId;
const node_async_hooks_1 = require("node:async_hooks");
/** Correlation id for the HTTP request currently being handled. */
exports.requestLogContext = new node_async_hooks_1.AsyncLocalStorage();
function currentRequestId() {
    return exports.requestLogContext.getStore()?.requestId;
}
/** HelloFresh user id for the /mcp request currently being handled. */
exports.helloFreshUserContext = new node_async_hooks_1.AsyncLocalStorage();
function currentHelloFreshUserId() {
    return exports.helloFreshUserContext.getStore();
}
//# sourceMappingURL=request-context.js.map