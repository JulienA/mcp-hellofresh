"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConfigError = exports.DEFAULT_AUTHORIZE_WINDOW_MS = exports.DEFAULT_AUTHORIZE_MAX_ATTEMPTS = exports.AUTH_CODE_TTL_SEC = exports.REFRESH_TOKEN_TTL_SEC = exports.ACCESS_TOKEN_TTL_SEC = exports.MCP_SCOPE = exports.DEFAULT_REDIRECT_HOSTS = void 0;
exports.isLoopbackHostname = isLoopbackHostname;
exports.isLocalIssuer = isLocalIssuer;
exports.loadHttpRuntimeConfig = loadHttpRuntimeConfig;
exports.redirectHostnameAllowed = redirectHostnameAllowed;
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const accounts_js_1 = require("./accounts.js");
exports.DEFAULT_REDIRECT_HOSTS = ["claude.ai", "claude.com", "chatgpt.com"];
exports.MCP_SCOPE = "mcp";
exports.ACCESS_TOKEN_TTL_SEC = 60 * 60;
exports.REFRESH_TOKEN_TTL_SEC = 60 * 60 * 24 * 30;
exports.AUTH_CODE_TTL_SEC = 5 * 60;
exports.DEFAULT_AUTHORIZE_MAX_ATTEMPTS = 10;
exports.DEFAULT_AUTHORIZE_WINDOW_MS = 15 * 60 * 1000;
class ConfigError extends Error {
    constructor(message) {
        super(message);
        this.name = "ConfigError";
    }
}
exports.ConfigError = ConfigError;
function isLoopbackHostname(hostname) {
    const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
}
function isLocalIssuer(url) {
    return isLoopbackHostname(url.hostname);
}
function parsePositiveInt(value, fallback) {
    if (!value) {
        return fallback;
    }
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
function resolveOAuthStorePath(env) {
    if (env.MCP_OAUTH_STORE_PATH) {
        return env.MCP_OAUTH_STORE_PATH;
    }
    if (env.XDG_CONFIG_HOME) {
        return (0, node_path_1.join)(env.XDG_CONFIG_HOME, "mcp-hellofresh", "oauth-store.json");
    }
    if (process.platform === "win32") {
        const root = env.APPDATA || (0, node_path_1.join)((0, node_os_1.homedir)(), "AppData", "Roaming");
        return (0, node_path_1.join)(root, "mcp-hellofresh", "oauth-store.json");
    }
    return (0, node_path_1.join)((0, node_os_1.homedir)(), ".config", "mcp-hellofresh", "oauth-store.json");
}
function parseRedirectHosts(env) {
    const raw = env.MCP_OAUTH_REDIRECT_HOSTS?.trim();
    if (!raw) {
        return [...exports.DEFAULT_REDIRECT_HOSTS];
    }
    return raw
        .split(/[,\s]+/)
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean);
}
function argvValue(argv, flag) {
    const index = argv.indexOf(flag);
    if (index >= 0 && argv[index + 1]) {
        return argv[index + 1];
    }
    const prefix = `${flag}=`;
    const matched = argv.find((item) => item.startsWith(prefix));
    return matched ? matched.slice(prefix.length) : undefined;
}
function loadHttpRuntimeConfig(env = process.env, argv = process.argv.slice(2)) {
    const host = argvValue(argv, "--host") || env.HOST || "127.0.0.1";
    const port = parsePositiveInt(argvValue(argv, "--port") || env.PORT, 8080);
    const publicBaseRaw = env.PUBLIC_BASE_URL?.trim();
    let publicBaseUrl;
    if (publicBaseRaw) {
        try {
            publicBaseUrl = new URL(publicBaseRaw);
        }
        catch {
            throw new ConfigError("PUBLIC_BASE_URL must be an absolute URL.");
        }
    }
    else {
        if (host === "0.0.0.0" || host === "::") {
            throw new ConfigError("PUBLIC_BASE_URL is required when HOST binds to all interfaces (0.0.0.0).");
        }
        const hostname = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
        publicBaseUrl = new URL(`http://${hostname}:${port}`);
    }
    if (publicBaseUrl.hash || publicBaseUrl.search) {
        throw new ConfigError("PUBLIC_BASE_URL must not include a query or fragment.");
    }
    if (publicBaseUrl.protocol !== "https:" && !isLocalIssuer(publicBaseUrl)) {
        throw new ConfigError("PUBLIC_BASE_URL must be HTTPS (HTTP is allowed only for localhost).");
    }
    const issuer = new URL(publicBaseUrl.origin);
    const resourceUrl = new URL("/mcp", issuer);
    const oauthStorePath = resolveOAuthStorePath(env);
    return {
        host,
        port,
        publicBaseUrl: issuer,
        issuer,
        resourceUrl,
        oauthStorePath,
        usersDir: (0, accounts_js_1.resolveUsersDir)(oauthStorePath, env),
        redirectHosts: parseRedirectHosts(env),
        allowLoopbackRedirects: env.MCP_OAUTH_ALLOW_LOOPBACK !== "0",
        authorizeMaxAttempts: parsePositiveInt(env.MCP_AUTHORIZE_MAX_ATTEMPTS, exports.DEFAULT_AUTHORIZE_MAX_ATTEMPTS),
        authorizeWindowMs: parsePositiveInt(env.MCP_AUTHORIZE_WINDOW_MS, exports.DEFAULT_AUTHORIZE_WINDOW_MS),
        dangerouslyAllowInsecureIssuerUrl: isLocalIssuer(issuer),
    };
}
function redirectHostnameAllowed(redirectUri, hosts, allowLoopback) {
    let parsed;
    try {
        parsed = new URL(redirectUri);
    }
    catch {
        return false;
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        return false;
    }
    const hostname = parsed.hostname.toLowerCase();
    if (allowLoopback && isLoopbackHostname(hostname)) {
        return parsed.protocol === "http:" || parsed.protocol === "https:";
    }
    if (parsed.protocol !== "https:") {
        return false;
    }
    return hosts.some((allowed) => {
        const needle = allowed.toLowerCase();
        return hostname === needle || hostname.endsWith(`.${needle}`);
    });
}
//# sourceMappingURL=config.js.map