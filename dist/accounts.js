"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AccountStore = exports.USERS_DIR_ENV_VAR = exports.ACCOUNT_ENV_VAR = void 0;
exports.normalizeEmail = normalizeEmail;
exports.userIdFor = userIdFor;
exports.resolveUsersDir = resolveUsersDir;
exports.resolveStdioAccountPath = resolveStdioAccountPath;
exports.accountFilePath = accountFilePath;
exports.readStoredAccount = readStoredAccount;
exports.writeStoredAccount = writeStoredAccount;
exports.decodeJwtClaims = decodeJwtClaims;
exports.emailFromClaims = emailFromClaims;
exports.parseApiV2Auth = parseApiV2Auth;
exports.findEmail = findEmail;
const promises_1 = require("node:fs/promises");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const countries_js_1 = require("./countries.js");
const secret_box_js_1 = require("./secret-box.js");
const security_js_1 = require("./security.js");
exports.ACCOUNT_ENV_VAR = "HELLOFRESH_ACCOUNT_PATH";
exports.USERS_DIR_ENV_VAR = "MCP_USERS_DIR";
function normalizeEmail(email) {
    return email.trim().toLowerCase();
}
function userIdFor(country, email) {
    const known = (0, countries_js_1.helloFreshCountry)(country);
    if (!known) {
        throw new Error(`Unknown HelloFresh country: ${country}`);
    }
    return (0, security_js_1.sha256Hex)(`${known.code}\n${normalizeEmail(email)}`);
}
function resolveUsersDir(oauthStorePath, env = process.env) {
    if (env[exports.USERS_DIR_ENV_VAR]?.trim()) {
        return env[exports.USERS_DIR_ENV_VAR].trim();
    }
    return (0, node_path_1.join)((0, node_path_1.dirname)(oauthStorePath), "users");
}
function resolveStdioAccountPath(env = process.env) {
    if (env[exports.ACCOUNT_ENV_VAR]?.trim()) {
        return env[exports.ACCOUNT_ENV_VAR].trim();
    }
    if (env.XDG_CONFIG_HOME) {
        return (0, node_path_1.join)(env.XDG_CONFIG_HOME, "mcp-hellofresh", "account.json");
    }
    if (process.platform === "win32") {
        const root = env.APPDATA || (0, node_path_1.join)((0, node_os_1.homedir)(), "AppData", "Roaming");
        return (0, node_path_1.join)(root, "mcp-hellofresh", "account.json");
    }
    return (0, node_path_1.join)((0, node_os_1.homedir)(), ".config", "mcp-hellofresh", "account.json");
}
function accountFilePath(usersDir, userId) {
    if (!/^[0-9a-f]{64}$/.test(userId)) {
        throw new Error("Refusing to resolve an account path for an unexpected user id");
    }
    return (0, node_path_1.join)(usersDir, userId, "tokens.json");
}
class AccountStore {
    usersDir;
    constructor(usersDir) {
        this.usersDir = usersDir;
    }
    fileFor(userId) {
        return accountFilePath(this.usersDir, userId);
    }
    async load(userId) {
        return readStoredAccount(this.fileFor(userId));
    }
    async save(account) {
        await writeStoredAccount(this.fileFor(account.userId), account);
    }
    async delete(userId) {
        const path = this.fileFor(userId);
        await (0, promises_1.rm)(path, { force: true });
        await (0, promises_1.rm)(`${path}.tmp`, { force: true });
    }
}
exports.AccountStore = AccountStore;
async function readStoredAccount(path) {
    const loaded = await (0, secret_box_js_1.readSecretText)(path, "account");
    if (!loaded) {
        return undefined;
    }
    const parsed = JSON.parse(loaded.text);
    if (!parsed || typeof parsed !== "object" || typeof parsed.accessToken !== "string") {
        return undefined;
    }
    if (typeof parsed.userId !== "string" || typeof parsed.email !== "string") {
        return undefined;
    }
    return parsed;
}
async function writeStoredAccount(path, account) {
    const payload = {
        userId: account.userId,
        email: account.email,
        country: account.country,
        accessToken: account.accessToken,
        refreshToken: account.refreshToken,
        issuedAt: account.issuedAt,
        expiresIn: account.expiresIn,
        refreshExpiresIn: account.refreshExpiresIn,
        refreshIssuedAt: account.refreshIssuedAt,
        tokenType: account.tokenType,
        savedAt: account.savedAt,
    };
    await (0, secret_box_js_1.writeSecretText)(path, JSON.stringify(payload), "account");
}
function decodeJwtClaims(token) {
    const parts = token.split(".");
    if (parts.length < 2) {
        return undefined;
    }
    try {
        const json = Buffer.from(parts[1], "base64url").toString("utf8");
        const claims = JSON.parse(json);
        return claims && typeof claims === "object" ? claims : undefined;
    }
    catch {
        return undefined;
    }
}
function emailFromClaims(claims) {
    if (!claims) {
        return undefined;
    }
    for (const key of ["email", "username"]) {
        const value = claims[key];
        if (typeof value === "string" && value.includes("@")) {
            return normalizeEmail(value);
        }
    }
    return undefined;
}
function coerceInt(value) {
    if (typeof value === "number" && Number.isFinite(value)) {
        return Math.trunc(value);
    }
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
        return Math.trunc(Number(value));
    }
    return undefined;
}
function loadsPossiblyEncoded(text) {
    let candidate = text.trim();
    for (let i = 0; i < 3; i += 1) {
        try {
            return JSON.parse(candidate);
        }
        catch {
            try {
                const decoded = decodeURIComponent(candidate);
                if (decoded === candidate) {
                    return undefined;
                }
                candidate = decoded;
            }
            catch {
                return undefined;
            }
        }
    }
    return undefined;
}
/** Accept a raw or URL-encoded apiV2Auth object, or a bare access token. */
function parseApiV2Auth(text) {
    if (!text?.trim()) {
        return undefined;
    }
    const parsed = loadsPossiblyEncoded(text);
    let accessToken;
    let payload = {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        payload = parsed;
        if (typeof payload.access_token === "string") {
            accessToken = payload.access_token.trim();
        }
    }
    else if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(text.trim())) {
        accessToken = text.trim();
    }
    if (!accessToken) {
        return undefined;
    }
    const claims = decodeJwtClaims(accessToken);
    const issuedAt = coerceInt(payload.issued_at) ?? coerceInt(claims?.iat);
    let expiresIn = coerceInt(payload.expires_in);
    const exp = coerceInt(claims?.exp);
    if (expiresIn === undefined && exp !== undefined && issuedAt !== undefined) {
        expiresIn = exp - issuedAt;
    }
    const refresh = payload.refresh_token;
    return {
        accessToken,
        refreshToken: typeof refresh === "string" && refresh.trim() ? refresh.trim() : undefined,
        issuedAt,
        expiresIn,
        refreshExpiresIn: coerceInt(payload.refresh_expires_in),
        refreshIssuedAt: coerceInt(payload.refresh_token_issued_at) ?? issuedAt,
        tokenType: typeof payload.token_type === "string" ? payload.token_type : undefined,
    };
}
function findEmail(value, depth = 0) {
    if (depth > 5 || value == null) {
        return undefined;
    }
    if (Array.isArray(value)) {
        for (const item of value) {
            const found = findEmail(item, depth + 1);
            if (found) {
                return found;
            }
        }
        return undefined;
    }
    if (typeof value === "object") {
        const record = value;
        for (const key of ["email", "username", "customerEmail"]) {
            const candidate = record[key];
            if (typeof candidate === "string" && candidate.includes("@")) {
                return normalizeEmail(candidate);
            }
        }
        for (const nested of Object.values(record)) {
            const found = findEmail(nested, depth + 1);
            if (found) {
                return found;
            }
        }
    }
    return undefined;
}
//# sourceMappingURL=accounts.js.map