"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_SESSION_FILENAME = exports.SESSION_ENV_VAR = void 0;
exports.resolveSessionPath = resolveSessionPath;
exports.isHelloFreshHost = isHelloFreshHost;
exports.isHelloFreshLoggedInUrl = isHelloFreshLoggedInUrl;
exports.toPlaywrightStorageState = toPlaywrightStorageState;
exports.filterHelloFreshStorageState = filterHelloFreshStorageState;
exports.helloFreshCookiesAreValid = helloFreshCookiesAreValid;
exports.loadPersistedSession = loadPersistedSession;
exports.savePersistedSession = savePersistedSession;
exports.deletePersistedSession = deletePersistedSession;
const promises_1 = require("node:fs/promises");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
exports.SESSION_ENV_VAR = "HELLOFRESH_SESSION_PATH";
exports.DEFAULT_SESSION_FILENAME = "session.json";
function resolveSessionPath(env = process.env, override) {
    if (override) {
        return override;
    }
    const fromEnv = env[exports.SESSION_ENV_VAR];
    if (fromEnv) {
        return fromEnv;
    }
    if (env.XDG_CONFIG_HOME) {
        return (0, node_path_1.join)(env.XDG_CONFIG_HOME, "mcp-hellofresh", exports.DEFAULT_SESSION_FILENAME);
    }
    if (process.platform === "win32") {
        const root = env.APPDATA || (0, node_path_1.join)((0, node_os_1.homedir)(), "AppData", "Roaming");
        return (0, node_path_1.join)(root, "mcp-hellofresh", exports.DEFAULT_SESSION_FILENAME);
    }
    return (0, node_path_1.join)((0, node_os_1.homedir)(), ".config", "mcp-hellofresh", exports.DEFAULT_SESSION_FILENAME);
}
function isHelloFreshHost(domainOrHost) {
    const host = domainOrHost.replace(/^\./, "").toLowerCase();
    return /(^|\.)hellofresh\./i.test(host);
}
function isHelloFreshLoggedInUrl(url) {
    try {
        const parsed = new URL(url);
        if (!isHelloFreshHost(parsed.hostname)) {
            return false;
        }
        const path = parsed.pathname;
        if (path.includes("/login") && !path.includes("/login/success")) {
            return false;
        }
        return true;
    }
    catch {
        return false;
    }
}
function toPlaywrightStorageState(state) {
    return {
        cookies: (state.cookies ?? []).map((cookie) => ({
            name: cookie.name,
            value: cookie.value,
            domain: cookie.domain,
            path: cookie.path ?? "/",
            expires: cookie.expires ?? -1,
            httpOnly: cookie.httpOnly ?? false,
            secure: cookie.secure ?? true,
            sameSite: cookie.sameSite ?? "Lax",
        })),
        origins: (state.origins ?? []).map((origin) => ({
            origin: origin.origin,
            localStorage: origin.localStorage ?? [],
        })),
    };
}
function filterHelloFreshStorageState(state) {
    return {
        cookies: (state.cookies ?? []).filter((cookie) => isHelloFreshHost(cookie.domain)),
        origins: (state.origins ?? []).filter((origin) => {
            try {
                return isHelloFreshHost(new URL(origin.origin).hostname);
            }
            catch {
                return false;
            }
        }),
    };
}
function helloFreshCookiesAreValid(state, nowMs = Date.now()) {
    const cookies = filterHelloFreshStorageState(state).cookies;
    if (cookies.length === 0) {
        return false;
    }
    const nowSec = nowMs / 1000;
    return cookies.some((cookie) => {
        const expires = cookie.expires ?? -1;
        return expires === -1 || expires > nowSec;
    });
}
async function loadPersistedSession(path) {
    try {
        const raw = await (0, promises_1.readFile)(path, "utf8");
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || !parsed.storageState) {
            return undefined;
        }
        const storageState = filterHelloFreshStorageState(parsed.storageState);
        if (storageState.cookies.length === 0 && storageState.origins.length === 0) {
            return undefined;
        }
        return {
            savedAt: typeof parsed.savedAt === "string" ? parsed.savedAt : new Date(0).toISOString(),
            storageState,
        };
    }
    catch (error) {
        const code = error.code;
        if (code === "ENOENT") {
            return undefined;
        }
        throw error;
    }
}
async function savePersistedSession(path, storageState, savedAt = new Date()) {
    const filtered = filterHelloFreshStorageState(storageState);
    const payload = {
        savedAt: savedAt.toISOString(),
        storageState: filtered,
    };
    const dir = (0, node_path_1.dirname)(path);
    await (0, promises_1.mkdir)(dir, { recursive: true, mode: 0o700 });
    const tmp = `${path}.tmp`;
    const json = JSON.stringify(payload, null, 2);
    await (0, promises_1.writeFile)(tmp, json, { mode: 0o600 });
    await (0, promises_1.chmod)(tmp, 0o600);
    await (0, promises_1.rename)(tmp, path);
    await (0, promises_1.chmod)(path, 0o600);
    return payload;
}
async function deletePersistedSession(path) {
    await (0, promises_1.rm)(path, { force: true });
    await (0, promises_1.rm)(`${path}.tmp`, { force: true });
}
//# sourceMappingURL=session.js.map