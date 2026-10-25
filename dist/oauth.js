"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.timingSafeEqualString = exports.OwnerAuthorizationServer = exports.RateLimiter = void 0;
exports.buildAuthorizationServerMetadata = buildAuthorizationServerMetadata;
exports.oauthJson = oauthJson;
exports.oauthErrorResponse = oauthErrorResponse;
exports.resourcesEqual = resourcesEqual;
exports.createStaticBearerAuthInfo = createStaticBearerAuthInfo;
exports.parseBearerToken = parseBearerToken;
const server_1 = require("@modelcontextprotocol/server");
const config_js_1 = require("./config.js");
const security_js_1 = require("./security.js");
Object.defineProperty(exports, "timingSafeEqualString", { enumerable: true, get: function () { return security_js_1.timingSafeEqualString; } });
const PKCE_CHALLENGE = /^[A-Za-z0-9_-]{43,128}$/;
class RateLimiter {
    maxAttempts;
    windowMs;
    hits = new Map();
    constructor(maxAttempts, windowMs) {
        this.maxAttempts = maxAttempts;
        this.windowMs = windowMs;
    }
    tooMany(key, now = Date.now()) {
        const cutoff = now - this.windowMs;
        const recent = (this.hits.get(key) ?? []).filter((ts) => ts > cutoff);
        this.hits.set(key, recent);
        return recent.length >= this.maxAttempts;
    }
    record(key, now = Date.now()) {
        const cutoff = now - this.windowMs;
        const recent = (this.hits.get(key) ?? []).filter((ts) => ts > cutoff);
        recent.push(now);
        this.hits.set(key, recent);
    }
}
exports.RateLimiter = RateLimiter;
function buildAuthorizationServerMetadata(issuer) {
    const base = issuer.origin;
    return {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        revocation_endpoint: `${base}/revoke`,
        scopes_supported: [config_js_1.MCP_SCOPE],
        response_types_supported: ["code"],
        response_modes_supported: ["query"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: [
            "none",
            "client_secret_post",
            "client_secret_basic",
        ],
        code_challenge_methods_supported: ["S256"],
        authorization_response_iss_parameter_supported: true,
    };
}
function oauthJson(body, status, extraHeaders) {
    return Response.json(body, {
        status,
        headers: {
            "Cache-Control": "no-store",
            Pragma: "no-cache",
            "Access-Control-Allow-Origin": "*",
            ...extraHeaders,
        },
    });
}
function oauthErrorResponse(error, status) {
    const mapped = status ??
        (error.code === server_1.OAuthErrorCode.InvalidClient ||
            error.code === server_1.OAuthErrorCode.InvalidToken
            ? 401
            : error.code === server_1.OAuthErrorCode.AccessDenied
                ? 403
                : error.code === server_1.OAuthErrorCode.TooManyRequests
                    ? 429
                    : error.code === server_1.OAuthErrorCode.MethodNotAllowed
                        ? 405
                        : 400);
    const headers = {};
    if (error.code === server_1.OAuthErrorCode.InvalidClient) {
        headers["WWW-Authenticate"] = 'Basic realm="mcp"';
    }
    return oauthJson(error.toResponseObject(), mapped, headers);
}
function corsPreflight() {
    return new Response(null, {
        status: 204,
        headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Authorization, Content-Type",
            "Access-Control-Max-Age": "86400",
        },
    });
}
function parseBasicAuth(header) {
    if (!header) {
        return undefined;
    }
    const match = /^Basic\s+(\S+)/i.exec(header);
    if (!match) {
        return undefined;
    }
    try {
        const decoded = Buffer.from(match[1], "base64").toString("utf8");
        const colon = decoded.indexOf(":");
        if (colon < 0) {
            return undefined;
        }
        return { id: decoded.slice(0, colon), secret: decoded.slice(colon + 1) };
    }
    catch {
        return undefined;
    }
}
async function readFormOrJson(request) {
    const contentType = request.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
        const body = (await request.json());
        const out = {};
        for (const [key, value] of Object.entries(body ?? {})) {
            if (typeof value === "string") {
                out[key] = value;
            }
            else if (Array.isArray(value) && typeof value[0] === "string") {
                out[key] = value[0];
            }
        }
        return out;
    }
    const text = await request.text();
    const params = new URLSearchParams(text);
    const out = {};
    for (const [key, value] of params.entries()) {
        out[key] = value;
    }
    return out;
}
class OwnerAuthorizationServer {
    config;
    store;
    pending = new Map();
    codes = new Map();
    rateLimiter;
    constructor(config, store) {
        this.config = config;
        this.store = store;
        this.rateLimiter = new RateLimiter(config.authorizeMaxAttempts, config.authorizeWindowMs);
    }
    async handle(request) {
        const url = new URL(request.url);
        const path = url.pathname;
        if (request.method === "OPTIONS" && ["/register", "/token", "/revoke", "/authorize"].includes(path)) {
            return corsPreflight();
        }
        if (path === "/register") {
            return this.handleRegister(request);
        }
        if (path === "/authorize") {
            return this.handleAuthorize(request);
        }
        if (path === "/token") {
            return this.handleToken(request);
        }
        if (path === "/revoke") {
            return this.handleRevoke(request);
        }
        return undefined;
    }
    async verifyAccessToken(token) {
        const record = await this.store.getToken(token);
        if (!record || record.kind !== "access") {
            throw new server_1.OAuthError(server_1.OAuthErrorCode.InvalidToken, "Access token is invalid");
        }
        const now = Date.now() / 1000;
        if (record.expiresAt <= now) {
            throw new server_1.OAuthError(server_1.OAuthErrorCode.InvalidToken, "Access token expired");
        }
        return {
            token,
            clientId: record.clientId,
            scopes: record.scopes,
            expiresAt: record.expiresAt,
            resource: new URL(record.resource),
        };
    }
    async handleRegister(request) {
        if (request.method !== "POST") {
            return oauthErrorResponse(new server_1.OAuthError(server_1.OAuthErrorCode.MethodNotAllowed, "POST required"), 405);
        }
        let body;
        try {
            body = (await request.json());
        }
        catch {
            return oauthErrorResponse(new server_1.OAuthError(server_1.OAuthErrorCode.InvalidClientMetadata, "Request body must be JSON"));
        }
        const redirectUris = Array.isArray(body.redirect_uris)
            ? body.redirect_uris.filter((item) => typeof item === "string")
            : [];
        if (redirectUris.length === 0) {
            return oauthErrorResponse(new server_1.OAuthError(server_1.OAuthErrorCode.InvalidRedirectUri, "redirect_uris is required"));
        }
        for (const uri of redirectUris) {
            if (!(0, config_js_1.redirectHostnameAllowed)(uri, this.config.redirectHosts, this.config.allowLoopbackRedirects)) {
                return oauthErrorResponse(new server_1.OAuthError(server_1.OAuthErrorCode.InvalidRedirectUri, `redirect_uri is not allowed: ${uri}`));
            }
        }
        const authMethod = typeof body.token_endpoint_auth_method === "string"
            ? body.token_endpoint_auth_method
            : "none";
        if (!["none", "client_secret_post", "client_secret_basic"].includes(authMethod)) {
            return oauthErrorResponse(new server_1.OAuthError(server_1.OAuthErrorCode.InvalidClientMetadata, "Unsupported token_endpoint_auth_method"));
        }
        const clientId = (0, security_js_1.randomToken)(16);
        const issuedAt = Math.floor(Date.now() / 1000);
        let clientSecret;
        let clientSecretHash = null;
        if (authMethod !== "none") {
            clientSecret = (0, security_js_1.randomToken)(32);
            clientSecretHash = (0, security_js_1.sha256Hex)(clientSecret);
        }
        const client = {
            clientId,
            clientSecretHash,
            tokenEndpointAuthMethod: authMethod,
            redirectUris,
            clientName: typeof body.client_name === "string" ? body.client_name : undefined,
            grantTypes: ["authorization_code", "refresh_token"],
            responseTypes: ["code"],
            issuedAt,
        };
        await this.store.putClient(client);
        return oauthJson({
            client_id: clientId,
            client_id_issued_at: issuedAt,
            client_secret: clientSecret,
            client_secret_expires_at: clientSecret ? 0 : undefined,
            token_endpoint_auth_method: authMethod,
            redirect_uris: redirectUris,
            grant_types: client.grantTypes,
            response_types: client.responseTypes,
            client_name: client.clientName,
        }, 201);
    }
    async handleAuthorize(request) {
        if (request.method === "GET") {
            return this.authorizeForm(new URL(request.url).searchParams);
        }
        if (request.method === "POST") {
            return this.authorizeSubmit(request);
        }
        return oauthErrorResponse(new server_1.OAuthError(server_1.OAuthErrorCode.MethodNotAllowed, "GET or POST required"), 405);
    }
    async authorizeForm(params) {
        const responseType = params.get("response_type") ?? "";
        const clientId = params.get("client_id") ?? "";
        const redirectUri = params.get("redirect_uri") ?? "";
        const state = params.get("state") ?? undefined;
        const codeChallenge = params.get("code_challenge") ?? "";
        const method = params.get("code_challenge_method") ?? "";
        const resource = params.get("resource") ?? this.config.resourceUrl.href;
        const scope = params.get("scope") ?? config_js_1.MCP_SCOPE;
        if (responseType !== "code") {
            return this.authorizeErrorRedirect(redirectUri, state, "unsupported_response_type", "Only response_type=code is supported", clientId);
        }
        if (!clientId) {
            return htmlError(400, "client_id is required");
        }
        const client = await this.store.getClient(clientId);
        if (!client) {
            return htmlError(400, "Unknown client_id");
        }
        if (!client.redirectUris.includes(redirectUri)) {
            return htmlError(400, "redirect_uri does not match the registered client");
        }
        if (!(0, config_js_1.redirectHostnameAllowed)(redirectUri, this.config.redirectHosts, this.config.allowLoopbackRedirects)) {
            return htmlError(400, "redirect_uri host is not allowed");
        }
        if (method !== "S256" || !PKCE_CHALLENGE.test(codeChallenge)) {
            return this.authorizeErrorRedirect(redirectUri, state, "invalid_request", "PKCE S256 code_challenge is required", clientId);
        }
        if (!resourcesEqual(resource, this.config.resourceUrl.href)) {
            return this.authorizeErrorRedirect(redirectUri, state, "invalid_target", "resource does not match this MCP server", clientId);
        }
        const id = (0, security_js_1.randomToken)(24);
        this.pending.set(id, {
            id,
            clientId,
            redirectUri,
            state,
            codeChallenge,
            resource: this.config.resourceUrl.href,
            scopes: scope.split(/[+\s]+/).filter(Boolean),
            expiresAt: Date.now() + config_js_1.AUTH_CODE_TTL_SEC * 1000,
        });
        const body = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authorize HelloFresh MCP</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 28rem; margin: 4rem auto; padding: 0 1rem; color: #111; }
    code { background: #f4f4f4; padding: 0.1rem 0.3rem; }
    button { padding: 0.5rem 1rem; }
    input[type=password] { width: 100%; padding: 0.5rem; box-sizing: border-box; }
    .note { color: #444; font-size: 0.9rem; }
  </style>
</head>
<body>
  <h1>Authorize this connector</h1>
  <p>This MCP server is single-user. Enter the <strong>owner secret</strong> from <code>MCP_OWNER_PASSWORD</code>.</p>
  <p class="note">This is not a Google or HelloFresh password. Do not type Google credentials here.</p>
  <form method="post" action="/authorize">
    <input type="hidden" name="request_id" value="${(0, security_js_1.htmlEscape)(id)}">
    <p>
      <label>Owner secret<br>
        <input type="password" name="password" autocomplete="current-password" required>
      </label>
    </p>
    <p><button type="submit">Allow access</button></p>
  </form>
</body>
</html>`;
        return new Response(body, {
            status: 200,
            headers: {
                "Content-Type": "text/html; charset=utf-8",
                "Cache-Control": "no-store",
                "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
            },
        });
    }
    async authorizeSubmit(request) {
        const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
            request.headers.get("cf-connecting-ip") ||
            "local";
        if (this.rateLimiter.tooMany(ip)) {
            return oauthErrorResponse(new server_1.OAuthError(server_1.OAuthErrorCode.TooManyRequests, "Too many authorize attempts"), 429);
        }
        this.rateLimiter.record(ip);
        const form = await readFormOrJson(request);
        const pending = this.pending.get(form.request_id ?? "");
        if (!pending || pending.expiresAt < Date.now()) {
            this.pending.delete(form.request_id ?? "");
            return htmlError(400, "Authorization request expired. Start again from the client.");
        }
        const submittedHash = (0, security_js_1.sha256Hex)(form.password ?? "");
        if (!(0, security_js_1.timingSafeEqualHex)(submittedHash, this.config.ownerPasswordSha256Hex)) {
            return htmlError(403, "Owner secret did not match.");
        }
        this.pending.delete(pending.id);
        const code = (0, security_js_1.randomToken)(32);
        this.codes.set((0, security_js_1.sha256Hex)(code), {
            clientId: pending.clientId,
            redirectUri: pending.redirectUri,
            codeChallenge: pending.codeChallenge,
            resource: pending.resource,
            scopes: pending.scopes.length ? pending.scopes : [config_js_1.MCP_SCOPE],
            expiresAt: Date.now() + config_js_1.AUTH_CODE_TTL_SEC * 1000,
        });
        const target = new URL(pending.redirectUri);
        target.searchParams.set("code", code);
        if (pending.state) {
            target.searchParams.set("state", pending.state);
        }
        target.searchParams.set("iss", this.config.issuer.origin);
        return Response.redirect(target.href, 302);
    }
    authorizeErrorRedirect(redirectUri, state, error, description, clientId) {
        try {
            const target = new URL(redirectUri);
            if (!clientId) {
                return htmlError(400, description);
            }
            target.searchParams.set("error", error);
            target.searchParams.set("error_description", description);
            if (state) {
                target.searchParams.set("state", state);
            }
            target.searchParams.set("iss", this.config.issuer.origin);
            return Response.redirect(target.href, 302);
        }
        catch {
            return htmlError(400, description);
        }
    }
    async handleToken(request) {
        if (request.method !== "POST") {
            return oauthErrorResponse(new server_1.OAuthError(server_1.OAuthErrorCode.MethodNotAllowed, "POST required"), 405);
        }
        const body = await readFormOrJson(request);
        const basic = parseBasicAuth(request.headers.get("authorization"));
        const clientId = basic?.id || body.client_id;
        const clientSecret = basic?.secret ?? body.client_secret;
        if (!clientId) {
            return oauthErrorResponse(new server_1.OAuthError(server_1.OAuthErrorCode.InvalidClient, "client_id is required"));
        }
        const client = await this.store.getClient(clientId);
        if (!client) {
            return oauthErrorResponse(new server_1.OAuthError(server_1.OAuthErrorCode.InvalidClient, "Unknown client"));
        }
        try {
            this.assertClientAuth(client, clientSecret);
        }
        catch (error) {
            if (error instanceof server_1.OAuthError) {
                return oauthErrorResponse(error);
            }
            throw error;
        }
        try {
            if (body.grant_type === "authorization_code") {
                return await this.exchangeCode(client, body);
            }
            if (body.grant_type === "refresh_token") {
                return await this.rotateRefresh(client, body);
            }
            throw new server_1.OAuthError(server_1.OAuthErrorCode.UnsupportedGrantType, "grant_type must be authorization_code or refresh_token");
        }
        catch (error) {
            if (error instanceof server_1.OAuthError) {
                return oauthErrorResponse(error);
            }
            throw error;
        }
    }
    assertClientAuth(client, secret) {
        if (client.tokenEndpointAuthMethod === "none") {
            return;
        }
        if (!client.clientSecretHash || !secret) {
            throw new server_1.OAuthError(server_1.OAuthErrorCode.InvalidClient, "Client authentication failed");
        }
        if (!(0, security_js_1.timingSafeEqualHex)((0, security_js_1.sha256Hex)(secret), client.clientSecretHash)) {
            throw new server_1.OAuthError(server_1.OAuthErrorCode.InvalidClient, "Client authentication failed");
        }
    }
    async exchangeCode(client, body) {
        const code = body.code;
        const verifier = body.code_verifier;
        const redirectUri = body.redirect_uri;
        if (!code || !verifier || !redirectUri) {
            throw new server_1.OAuthError(server_1.OAuthErrorCode.InvalidRequest, "code, redirect_uri, and code_verifier are required");
        }
        const hashed = (0, security_js_1.sha256Hex)(code);
        const stored = this.codes.get(hashed);
        this.codes.delete(hashed);
        if (!stored || stored.expiresAt < Date.now()) {
            throw new server_1.OAuthError(server_1.OAuthErrorCode.InvalidGrant, "Authorization code is invalid or expired");
        }
        if (stored.clientId !== client.clientId) {
            throw new server_1.OAuthError(server_1.OAuthErrorCode.InvalidGrant, "Authorization code was issued to another client");
        }
        if (stored.redirectUri !== redirectUri) {
            throw new server_1.OAuthError(server_1.OAuthErrorCode.InvalidGrant, "redirect_uri does not match");
        }
        if (!(0, security_js_1.timingSafeEqualString)((0, security_js_1.sha256Base64Url)(verifier), stored.codeChallenge)) {
            throw new server_1.OAuthError(server_1.OAuthErrorCode.InvalidGrant, "PKCE verification failed");
        }
        const resource = body.resource ?? stored.resource;
        if (!resourcesEqual(resource, stored.resource)) {
            throw new server_1.OAuthError(server_1.OAuthErrorCode.InvalidTarget, "resource does not match the authorization");
        }
        return this.issueTokens(client.clientId, stored.scopes, stored.resource);
    }
    async rotateRefresh(client, body) {
        const refreshToken = body.refresh_token;
        if (!refreshToken) {
            throw new server_1.OAuthError(server_1.OAuthErrorCode.InvalidRequest, "refresh_token is required");
        }
        const record = await this.store.getToken(refreshToken);
        if (!record || record.kind !== "refresh") {
            throw new server_1.OAuthError(server_1.OAuthErrorCode.InvalidGrant, "Refresh token is invalid");
        }
        if (record.clientId !== client.clientId) {
            throw new server_1.OAuthError(server_1.OAuthErrorCode.InvalidGrant, "Refresh token was issued to another client");
        }
        if (record.expiresAt <= Date.now() / 1000) {
            throw new server_1.OAuthError(server_1.OAuthErrorCode.InvalidGrant, "Refresh token expired");
        }
        const resource = body.resource ?? record.resource;
        if (!resourcesEqual(resource, record.resource)) {
            throw new server_1.OAuthError(server_1.OAuthErrorCode.InvalidTarget, "resource does not match the refresh token");
        }
        return this.issueTokens(client.clientId, record.scopes, record.resource, {
            replaceAccessHash: record.accessHash,
            replaceRefreshHash: (0, security_js_1.sha256Hex)(refreshToken),
        });
    }
    async issueTokens(clientId, scopes, resource, replace) {
        const accessToken = `mcp_${(0, security_js_1.randomToken)(32)}`;
        const refreshToken = `mcr_${(0, security_js_1.randomToken)(32)}`;
        const now = Math.floor(Date.now() / 1000);
        await this.store.putTokenPair({
            accessToken,
            refreshToken,
            clientId,
            accessExpiresAt: now + config_js_1.ACCESS_TOKEN_TTL_SEC,
            refreshExpiresAt: now + config_js_1.REFRESH_TOKEN_TTL_SEC,
            scopes,
            resource,
            replaceAccessHash: replace?.replaceAccessHash,
            replaceRefreshHash: replace?.replaceRefreshHash,
        });
        return oauthJson({
            access_token: accessToken,
            token_type: "Bearer",
            expires_in: config_js_1.ACCESS_TOKEN_TTL_SEC,
            refresh_token: refreshToken,
            scope: scopes.join(" "),
        }, 200);
    }
    async handleRevoke(request) {
        if (request.method !== "POST") {
            return oauthErrorResponse(new server_1.OAuthError(server_1.OAuthErrorCode.MethodNotAllowed, "POST required"), 405);
        }
        const body = await readFormOrJson(request);
        if (body.token) {
            await this.store.revokeToken(body.token);
        }
        return new Response(null, { status: 200, headers: { "Access-Control-Allow-Origin": "*" } });
    }
}
exports.OwnerAuthorizationServer = OwnerAuthorizationServer;
function resourcesEqual(left, right) {
    return normalizeResource(left) === normalizeResource(right);
}
function normalizeResource(value) {
    const url = new URL(value);
    url.hash = "";
    let href = url.href;
    if (href.endsWith("/")) {
        href = href.slice(0, -1);
    }
    return href;
}
function htmlError(status, message) {
    const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Authorization error</title></head><body><p>${(0, security_js_1.htmlEscape)(message)}</p></body></html>`;
    return new Response(body, {
        status,
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    });
}
function createStaticBearerAuthInfo(token, resource) {
    return {
        token,
        clientId: "owner-bearer",
        scopes: [config_js_1.MCP_SCOPE],
        expiresAt: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365,
        resource,
    };
}
function parseBearerToken(header) {
    if (!header) {
        return undefined;
    }
    const match = /^Bearer\s+(\S+)/i.exec(header);
    return match?.[1];
}
//# sourceMappingURL=oauth.js.map