"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AccountClients = exports.STDIO_RECONNECT_MESSAGE = void 0;
exports.createStdioSession = createStdioSession;
const promises_1 = require("node:fs/promises");
const auth_js_1 = require("./auth.js");
const accounts_js_1 = require("./accounts.js");
const hellofresh_api_js_1 = require("./hellofresh-api.js");
exports.STDIO_RECONNECT_MESSAGE = "No HelloFresh account is saved on this machine. Run `npm run login` and finish Continue with Google in the window, or set HELLOFRESH_EMAIL and HELLOFRESH_PASSWORD for a HelloFresh password account. Do not send a Google password.";
const SIGNED_OUT = {
    authenticated: false,
    email: null,
    country: null,
    accessTokenValid: false,
    savedAt: null,
    reconnectRequired: true,
};
class AccountClients {
    store;
    fetchImpl;
    clients = new Map();
    constructor(store, fetchImpl = fetch) {
        this.store = store;
        this.fetchImpl = fetchImpl;
    }
    sessionFor(userId) {
        return {
            status: async () => {
                const cached = this.clients.get(userId);
                if (cached) {
                    return cached.status();
                }
                const account = await this.store.load(userId);
                if (!account) {
                    return SIGNED_OUT;
                }
                return {
                    authenticated: true,
                    email: account.email,
                    country: account.country,
                    accessTokenValid: account.issuedAt + account.expiresIn > Math.floor(Date.now() / 1000),
                    savedAt: account.savedAt,
                    reconnectRequired: false,
                };
            },
            logout: async () => {
                this.clients.delete(userId);
                await this.store.delete(userId);
            },
            api: () => this.clientFor(userId),
        };
    }
    async clientFor(userId) {
        const cached = this.clients.get(userId);
        if (cached) {
            return cached;
        }
        const account = await this.store.load(userId);
        if (!account) {
            throw new hellofresh_api_js_1.HelloFreshApiError("reconnect_required", hellofresh_api_js_1.RECONNECT_MESSAGE);
        }
        const client = new hellofresh_api_js_1.HelloFreshApi(account, this.fetchImpl, {
            onUpdate: async (next) => {
                await this.store.save(next);
            },
        });
        this.clients.set(userId, client);
        return client;
    }
}
exports.AccountClients = AccountClients;
function createStdioSession(env = process.env, fetchImpl = fetch) {
    const path = (0, accounts_js_1.resolveStdioAccountPath)(env);
    let cached;
    const persist = async (account) => {
        await (0, accounts_js_1.writeStoredAccount)(path, account);
    };
    const relogin = async () => {
        const creds = (0, auth_js_1.readOptionalPasswordCredentials)(env);
        const country = env.HELLOFRESH_COUNTRY?.trim() || "us";
        if (!creds) {
            throw new hellofresh_api_js_1.HelloFreshApiError("reconnect_required", exports.STDIO_RECONNECT_MESSAGE);
        }
        const api = await hellofresh_api_js_1.HelloFreshApi.login({
            email: creds.email,
            password: creds.password,
            country,
            fetchImpl,
        });
        const stored = api.toStoredAccount();
        await persist(stored);
        cached = new hellofresh_api_js_1.HelloFreshApi(stored, fetchImpl, { onUpdate: persist, relogin });
        return stored;
    };
    return {
        status: async () => {
            if (cached) {
                return cached.status();
            }
            const account = await (0, accounts_js_1.readStoredAccount)(path);
            if (!account) {
                return { ...SIGNED_OUT, reconnectRequired: true };
            }
            return {
                authenticated: true,
                email: account.email,
                country: account.country,
                accessTokenValid: account.issuedAt + account.expiresIn > Math.floor(Date.now() / 1000),
                savedAt: account.savedAt,
                reconnectRequired: false,
            };
        },
        logout: async () => {
            cached = undefined;
            await (0, promises_1.rm)(path, { force: true });
            await (0, promises_1.rm)(`${path}.tmp`, { force: true });
        },
        api: async () => {
            if (cached) {
                return cached;
            }
            const existing = await (0, accounts_js_1.readStoredAccount)(path);
            if (!existing) {
                const stored = await relogin();
                cached = new hellofresh_api_js_1.HelloFreshApi(stored, fetchImpl, { onUpdate: persist, relogin });
                return cached;
            }
            cached = new hellofresh_api_js_1.HelloFreshApi(existing, fetchImpl, { onUpdate: persist, relogin });
            return cached;
        },
        login: async () => {
            const { captureHelloFreshAccount } = await import("./login-browser.js");
            const country = env.HELLOFRESH_COUNTRY?.trim() || "us";
            const stored = await captureHelloFreshAccount({ country, fetchImpl });
            await persist(stored);
            cached = new hellofresh_api_js_1.HelloFreshApi(stored, fetchImpl, { onUpdate: persist, relogin });
            return { savedAt: stored.savedAt, email: stored.email, country: stored.country };
        },
    };
}
//# sourceMappingURL=hellofresh-session.js.map