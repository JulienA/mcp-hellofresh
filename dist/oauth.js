"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.timingSafeEqualString = exports.OwnerAuthorizationServer = exports.RateLimiter = void 0;
exports.buildAuthorizationServerMetadata = buildAuthorizationServerMetadata;
exports.oauthJson = oauthJson;
exports.oauthErrorResponse = oauthErrorResponse;
exports.resourcesEqual = resourcesEqual;
const server_1 = require("@modelcontextprotocol/server");
const config_js_1 = require("./config.js");
const countries_js_1 = require("./countries.js");
const hellofresh_api_js_1 = require("./hellofresh-api.js");
const log_js_1 = require("./log.js");
const accounts_js_1 = require("./accounts.js");
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
    linker;
    pending = new Map();
    codes = new Map();
    rateLimiter;
    constructor(config, store, linker) {
        this.config = config;
        this.store = store;
        this.linker = linker;
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
        if (!record || record.kind !== "access" || !record.userId) {
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
            extra: { userId: record.userId },
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
                log_js_1.log.warn("oauth.register", { outcome: "rejected", reason: "redirect_uri" });
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
        log_js_1.log.info("oauth.register", {
            clientId,
            clientName: client.clientName,
            redirectHosts: uniqueRedirectHosts(redirectUris),
        });
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
            log_js_1.log.warn("oauth.authorize", { outcome: "rejected", reason: "unknown_client" });
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
        log_js_1.log.info("oauth.authorize", { outcome: "form", clientId });
        return this.renderAuthorize(id);
    }
    renderAuthorize(requestId, error) {
        const options = countries_js_1.HELLOFRESH_COUNTRIES.map((country) => `<option value="${(0, security_js_1.htmlEscape)(country.code)}">${(0, security_js_1.htmlEscape)(country.label)}</option>`).join("");
        const errorBlock = error ? `<p class="error">${(0, security_js_1.htmlEscape)(error)}</p>` : "";
        const body = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Connect HelloFresh</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 32rem; margin: 3rem auto; padding: 0 1rem; color: #111; }
    code { background: #f4f4f4; padding: 0.1rem 0.3rem; }
    button { padding: 0.5rem 1rem; }
    input, select, textarea { width: 100%; padding: 0.5rem; box-sizing: border-box; }
    .note { color: #444; font-size: 0.9rem; }
    .error { color: #8a1f1f; }
    fieldset { margin: 1rem 0; }
  </style>
</head>
<body>
  <h1>Connect your HelloFresh account</h1>
  <p class="note">This links only your account. Do not type a Google password here.</p>
  ${errorBlock}
  <form method="post" action="/authorize">
    <input type="hidden" name="request_id" value="${(0, security_js_1.htmlEscape)(requestId)}">
    <p>
      <label>Country<br>
        <select name="country" required>
          <option value="" selected disabled>Choose a country</option>
          ${options}
        </select>
      </label>
    </p>
    <fieldset>
      <legend>HelloFresh password</legend>
      <p class="note">The password for your HelloFresh account, not Google, Apple, or Facebook.</p>
      <p><label>Email<br><input type="email" name="email" autocomplete="username"></label></p>
      <p><label>Password<br><input type="password" name="password" autocomplete="current-password"></label></p>
      <p><button type="submit" name="auth_method" value="password">Sign in</button></p>
    </fieldset>
    <fieldset>
      <legend>I already signed in, including with Google</legend>
      <p class="note">Sign in on the HelloFresh website yourself, then paste the <code>apiV2Auth</code> value from that browser. Only the HelloFresh tokens are kept.</p>
      <p><label>apiV2Auth<br><textarea name="api_v2_auth" rows="4" autocomplete="off"></textarea></label></p>
      <p><button type="submit" name="auth_method" value="token">Use this sign-in</button></p>
    </fieldset>
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
        const form = await readFormOrJson(request);
        const emailKey = form.email ? `email:${(0, accounts_js_1.normalizeEmail)(form.email)}` : undefined;
        if (this.rateLimiter.tooMany(ip) || (emailKey && this.rateLimiter.tooMany(emailKey))) {
            log_js_1.log.warn("oauth.authorize", { outcome: "rate_limited" });
            return oauthErrorResponse(new server_1.OAuthError(server_1.OAuthErrorCode.TooManyRequests, "Too many authorize attempts"), 429);
        }
        this.rateLimiter.record(ip);
        if (emailKey) {
            this.rateLimiter.record(emailKey);
        }
        const pending = this.pending.get(form.request_id ?? "");
        if (!pending || pending.expiresAt < Date.now()) {
            this.pending.delete(form.request_id ?? "");
            log_js_1.log.warn("oauth.authorize", { outcome: "expired" });
            return htmlError(400, "Authorization request expired. Start again from the client.");
        }
        const method = form.auth_method === "token" ? "token" : "password";
        let userId;
        try {
            if (method === "token") {
                const linked = await this.linker.linkWithToken({
                    country: form.country ?? "",
                    token: form.api_v2_auth ?? "",
                });
                userId = linked.userId;
            }
            else {
                const linked = await this.linker.linkWithPassword({
                    country: form.country ?? "",
                    email: form.email ?? "",
                    password: form.password ?? "",
                });
                userId = linked.userId;
            }
        }
        catch (error) {
            const code = (0, log_js_1.errorCode)(error);
            if (error instanceof hellofresh_api_js_1.HelloFreshApiError && error.code === "rate_limited") {
                log_js_1.log.warn("oauth.authorize", { outcome: "rate_limited", method, country: form.country });
                return oauthErrorResponse(new server_1.OAuthError(server_1.OAuthErrorCode.TooManyRequests, "Too many authorize attempts"), 429);
            }
            log_js_1.log.warn("oauth.authorize", { outcome: "rejected", method, country: form.country, code });
            const message = error instanceof hellofresh_api_js_1.HelloFreshApiError
                ? error.message
                : "HelloFresh did not accept these credentials.";
            return this.renderAuthorize(pending.id, message);
        }
        this.pending.delete(pending.id);
        log_js_1.log.info("oauth.authorize", {
            outcome: "linked",
            method,
            country: form.country,
            userId,
            clientId: pending.clientId,
        });
        const code = (0, security_js_1.randomToken)(32);
        this.codes.set((0, security_js_1.sha256Hex)(code), {
            clientId: pending.clientId,
            redirectUri: pending.redirectUri,
            codeChallenge: pending.codeChallenge,
            resource: pending.resource,
            scopes: pending.scopes.length ? pending.scopes : [config_js_1.MCP_SCOPE],
            userId,
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
                log_js_1.log.warn("oauth.token", {
                    grantType: body.grant_type,
                    outcome: "rejected",
                    code: error.code,
                    clientId,
                });
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
        const issued = await this.issueTokens(client.clientId, stored.userId, stored.scopes, stored.resource);
        log_js_1.log.info("oauth.token", {
            grantType: "authorization_code",
            outcome: "issued",
            clientId: client.clientId,
            userId: stored.userId,
        });
        return issued;
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
        if (!record.userId) {
            throw new server_1.OAuthError(server_1.OAuthErrorCode.InvalidGrant, "Refresh token is not linked to a HelloFresh account");
        }
        const resource = body.resource ?? record.resource;
        if (!resourcesEqual(resource, record.resource)) {
            throw new server_1.OAuthError(server_1.OAuthErrorCode.InvalidTarget, "resource does not match the refresh token");
        }
        const issued = await this.issueTokens(client.clientId, record.userId, record.scopes, record.resource, {
            replaceAccessHash: record.accessHash,
            replaceRefreshHash: (0, security_js_1.sha256Hex)(refreshToken),
        });
        log_js_1.log.info("oauth.token", {
            grantType: "refresh_token",
            outcome: "issued",
            clientId: client.clientId,
            userId: record.userId,
        });
        return issued;
    }
    async issueTokens(clientId, userId, scopes, resource, replace) {
        const accessToken = `mcp_${(0, security_js_1.randomToken)(32)}`;
        const refreshToken = `mcr_${(0, security_js_1.randomToken)(32)}`;
        const now = Math.floor(Date.now() / 1000);
        await this.store.putTokenPair({
            accessToken,
            refreshToken,
            clientId,
            userId,
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
        log_js_1.log.info("oauth.revoke", { revoked: Boolean(body.token) });
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
function uniqueRedirectHosts(uris) {
    const hosts = [];
    for (const uri of uris) {
        try {
            const host = new URL(uri).hostname.toLowerCase();
            if (host && !hosts.includes(host)) {
                hosts.push(host);
            }
        }
        catch {
            // Skip unparseable redirect URIs; the allowlist already rejected bad ones.
        }
    }
    return hosts;
}
function htmlError(status, message) {
    const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Authorization error</title></head><body><p>${(0, security_js_1.htmlEscape)(message)}</p></body></html>`;
    return new Response(body, {
        status,
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    });
}
//# sourceMappingURL=oauth.js.map