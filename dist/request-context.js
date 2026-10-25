"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.helloFreshUserContext = void 0;
exports.currentHelloFreshUserId = currentHelloFreshUserId;
const node_async_hooks_1 = require("node:async_hooks");
/** HelloFresh user id for the /mcp request currently being handled. */
exports.helloFreshUserContext = new node_async_hooks_1.AsyncLocalStorage();
function currentHelloFreshUserId() {
    return exports.helloFreshUserContext.getStore();
}
//# sourceMappingURL=request-context.js.map