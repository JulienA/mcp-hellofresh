"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OAuthStore = exports.OAUTH_STORE_ENV_VAR = void 0;
exports.emptyOAuthStoreFile = emptyOAuthStoreFile;
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const auth_js_1 = require("./auth.js");
const security_js_1 = require("./security.js");
exports.OAUTH_STORE_ENV_VAR = "MCP_OAUTH_STORE_PATH";
const EMPTY_STORE = { clients: {}, tokens: {} };
class OAuthStore {
    filePath;
    mutex = new auth_js_1.AsyncMutex();
    loaded;
    constructor(filePath) {
        this.filePath = filePath;
    }
    get path() {
        return this.filePath;
    }
    async getClient(clientId) {
        const data = await this.load();
        return data.clients[clientId];
    }
    async putClient(client) {
        await this.mutex.runExclusive(async () => {
            const data = await this.loadUnlocked();
            data.clients[client.clientId] = client;
            await this.saveUnlocked(data);
        });
    }
    async getToken(rawToken) {
        const data = await this.load();
        return data.tokens[(0, security_js_1.sha256Hex)(rawToken)];
    }
    async getTokenByHash(tokenHash) {
        const data = await this.load();
        return data.tokens[tokenHash];
    }
    async putTokenPair(input) {
        await this.mutex.runExclusive(async () => {
            const data = await this.loadUnlocked();
            this.pruneExpiredUnlocked(data);
            if (input.replaceAccessHash) {
                delete data.tokens[input.replaceAccessHash];
            }
            if (input.replaceRefreshHash) {
                delete data.tokens[input.replaceRefreshHash];
            }
            const accessHash = (0, security_js_1.sha256Hex)(input.accessToken);
            const refreshHash = (0, security_js_1.sha256Hex)(input.refreshToken);
            data.tokens[accessHash] = {
                kind: "access",
                clientId: input.clientId,
                userId: input.userId,
                refreshHash,
                expiresAt: input.accessExpiresAt,
                scopes: input.scopes,
                resource: input.resource,
            };
            data.tokens[refreshHash] = {
                kind: "refresh",
                clientId: input.clientId,
                userId: input.userId,
                accessHash,
                expiresAt: input.refreshExpiresAt,
                scopes: input.scopes,
                resource: input.resource,
            };
            await this.saveUnlocked(data);
        });
    }
    async revokeToken(rawToken) {
        await this.mutex.runExclusive(async () => {
            const data = await this.loadUnlocked();
            const hash = (0, security_js_1.sha256Hex)(rawToken);
            const record = data.tokens[hash];
            if (!record) {
                return;
            }
            delete data.tokens[hash];
            if (record.kind === "access") {
                delete data.tokens[record.refreshHash];
            }
            else {
                delete data.tokens[record.accessHash];
            }
            await this.saveUnlocked(data);
        });
    }
    async load() {
        return this.mutex.runExclusive(() => this.loadUnlocked());
    }
    async loadUnlocked() {
        if (this.loaded) {
            return this.loaded;
        }
        try {
            const raw = await (0, promises_1.readFile)(this.filePath, "utf8");
            const parsed = JSON.parse(raw);
            this.loaded = {
                clients: parsed.clients && typeof parsed.clients === "object" ? parsed.clients : {},
                tokens: parsed.tokens && typeof parsed.tokens === "object" ? parsed.tokens : {},
            };
        }
        catch (error) {
            const code = error.code;
            if (code !== "ENOENT") {
                throw error;
            }
            this.loaded = { clients: {}, tokens: {} };
        }
        return this.loaded;
    }
    pruneExpiredUnlocked(data, now = Date.now() / 1000) {
        for (const [hash, token] of Object.entries(data.tokens)) {
            if (token.expiresAt <= now) {
                delete data.tokens[hash];
            }
        }
    }
    async saveUnlocked(data) {
        const dir = (0, node_path_1.dirname)(this.filePath);
        await (0, promises_1.mkdir)(dir, { recursive: true, mode: 0o700 });
        const tmp = `${this.filePath}.tmp`;
        const json = JSON.stringify(data, null, 2);
        await (0, promises_1.writeFile)(tmp, json, { mode: 0o600 });
        await (0, promises_1.chmod)(tmp, 0o600);
        await (0, promises_1.rename)(tmp, this.filePath);
        await (0, promises_1.chmod)(this.filePath, 0o600);
        this.loaded = data;
    }
}
exports.OAuthStore = OAuthStore;
function emptyOAuthStoreFile() {
    return { clients: { ...EMPTY_STORE.clients }, tokens: { ...EMPTY_STORE.tokens } };
}
//# sourceMappingURL=oauth-store.js.map