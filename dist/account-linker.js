"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createAccountLinker = createAccountLinker;
const accounts_js_1 = require("./accounts.js");
const hellofresh_api_js_1 = require("./hellofresh-api.js");
const log_js_1 = require("./log.js");
function createAccountLinker(store, fetchImpl = fetch) {
    return {
        async linkWithPassword(input) {
            const api = await hellofresh_api_js_1.HelloFreshApi.login({ ...input, fetchImpl });
            const stored = api.toStoredAccount();
            await store.save(stored);
            log_js_1.log.info("account.linked", { method: "password", country: stored.country, userId: stored.userId });
            return { userId: stored.userId };
        },
        async linkWithToken(input) {
            const parsed = (0, accounts_js_1.parseApiV2Auth)(input.token);
            const api = await hellofresh_api_js_1.HelloFreshApi.fromPasted({
                token: input.token,
                country: input.country,
                fetchImpl,
                parsed,
            });
            const stored = api.toStoredAccount();
            await store.save(stored);
            log_js_1.log.info("account.linked", { method: "token", country: stored.country, userId: stored.userId });
            return { userId: stored.userId };
        },
    };
}
//# sourceMappingURL=account-linker.js.map