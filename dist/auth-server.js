"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createAuthorizationServer = createAuthorizationServer;
exports.isAuthorizationServerPath = isAuthorizationServerPath;
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const node_sqlite_1 = require("node:sqlite");
const better_auth_1 = require("better-auth");
const api_1 = require("better-auth/api");
const cookies_1 = require("better-auth/cookies");
const plugins_1 = require("better-auth/plugins");
const cimd_1 = require("@better-auth/cimd");
const node_1 = require("@better-auth/cimd/node");
const mcp_1 = require("@better-auth/mcp");
const oauth_provider_1 = require("@better-auth/oauth-provider");
const config_js_1 = require("./config.js");
const countries_js_1 = require("./countries.js");
const hellofresh_api_js_1 = require("./hellofresh-api.js");
const log_js_1 = require("./log.js");
const security_js_1 = require("./security.js");
const zod_1 = require("zod");
const LOCAL_USER_DOMAIN = "users.local";
const HTML_HEADERS = {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
};
async function createAuthorizationServer(config, linker, options = {}) {
    const issuer = config.issuer.origin;
    const resource = config.resourceUrl.href;
    const secret = config.authSecret;
    if (secret.length < 32) {
        throw new Error("BETTER_AUTH_SECRET or MCP_DATA_KEY must be at least 32 characters.");
    }
    await (0, promises_1.mkdir)((0, node_path_1.dirname)(config.authDbPath), { recursive: true, mode: 0o700 });
    const db = new node_sqlite_1.DatabaseSync(config.authDbPath);
    const authRef = {};
    const auth = (0, better_auth_1.betterAuth)({
        appName: "HelloFresh MCP",
        baseURL: issuer,
        basePath: "/",
        secret,
        database: db,
        telemetry: { enabled: false },
        logger: { disabled: true },
        trustedOrigins: [issuer],
        disabledPaths: ["/token"],
        rateLimit: {
            window: 60,
            max: 100,
            customRules: {
                "/sign-in": { window: 900, max: 10 },
            },
        },
        user: {
            additionalFields: {
                hellofreshUserId: {
                    type: "string",
                    required: true,
                    unique: true,
                    input: false,
                },
            },
        },
        plugins: [
            (0, plugins_1.jwt)({
                disableSettingJwtHeader: true,
                jwt: { issuer },
                jwks: { keyPairConfig: { alg: "EdDSA" } },
            }),
            (0, mcp_1.mcp)({
                loginPage: "/sign-in",
                consentPage: "/consent",
                resource,
                allowDynamicClientRegistration: true,
                allowUnauthenticatedClientRegistration: true,
                clientRegistrationDefaultApplicationType: "infer",
                scopes: [config_js_1.MCP_SCOPE, "openid", "offline_access"],
                grantTypes: ["authorization_code", "refresh_token"],
                accessTokenExpiresIn: options.accessTokenExpiresIn ?? config_js_1.ACCESS_TOKEN_TTL_SEC,
                refreshTokenExpiresIn: config_js_1.REFRESH_TOKEN_TTL_SEC,
                codeExpiresIn: config_js_1.AUTH_CODE_TTL_SEC,
                refreshTokenReuseInterval: 0,
                rateLimit: {
                    register: { window: 60, max: 20 },
                },
                customAccessTokenClaims: ({ user }) => {
                    const userId = user?.hellofreshUserId;
                    return typeof userId === "string" && userId ? { userId } : {};
                },
                validateRedirectUri: (redirectUri, _registered, defaultResult) => defaultResult &&
                    (0, config_js_1.redirectHostnameAllowed)(redirectUri, config.redirectHosts, config.allowLoopbackRedirects),
            }),
            (0, cimd_1.cimd)({
                fetchClientMetadataResource: node_1.fetchClientMetadataResource,
                metadataProfile: "mcp-2026-07-28",
            }),
            helloFreshInteractionPlugin({
                linker,
                getAuth: () => authRef.current,
            }),
        ],
    });
    authRef.current = auth;
    const ctx = await auth.$context;
    await ctx.runMigrations();
    await (0, promises_1.chmod)(config.authDbPath, 0o600).catch(() => undefined);
    const handler = async (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/oauth2/register" && request.method === "POST") {
            return registerWithAllowlist(auth, request, config);
        }
        return asBrowserRedirect(await auth.handler(request));
    };
    return {
        handler,
        jwksUrl: new URL("/jwks", issuer),
        issuer,
        close: () => db.close(),
    };
}
function isAuthorizationServerPath(pathname) {
    const path = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
    return (path === "/sign-in" ||
        path === "/consent" ||
        path === "/jwks" ||
        path === "/.well-known/oauth-authorization-server" ||
        path === "/.well-known/openid-configuration" ||
        path.startsWith("/oauth2/"));
}
function helloFreshInteractionPlugin(options) {
    return {
        id: "hellofresh-sign-in",
        endpoints: {
            signInPage: (0, api_1.createAuthEndpoint)("/sign-in", { method: "GET" }, async (ctx) => {
                const query = signedQueryFrom(ctx.request);
                if (!query || !(await (0, oauth_provider_1.verifyOAuthQueryParams)(query, ctx.context.secret))) {
                    log_js_1.log.warn("oauth.authorize", { outcome: "rejected", reason: "query" });
                    return htmlError(400, "Authorization request expired. Start again from the client.");
                }
                log_js_1.log.info("oauth.authorize", { outcome: "form", clientId: ctx.query?.client_id });
                return renderAuthorize();
            }),
            signInSubmit: (0, api_1.createAuthEndpoint)("/sign-in", {
                method: "POST",
                metadata: {
                    allowedMediaTypes: ["application/x-www-form-urlencoded"],
                },
                body: zod_1.z.object({
                    auth_method: zod_1.z.string().optional(),
                    country: zod_1.z.string().optional(),
                    email: zod_1.z.string().optional(),
                    password: zod_1.z.string().optional(),
                    api_v2_auth: zod_1.z.string().optional(),
                }),
            }, async (ctx) => {
                const query = signedQueryFrom(ctx.request);
                if (!query || !(await (0, oauth_provider_1.verifyOAuthQueryParams)(query, ctx.context.secret))) {
                    log_js_1.log.warn("oauth.authorize", { outcome: "expired" });
                    return htmlError(400, "Authorization request expired. Start again from the client.");
                }
                const method = ctx.body.auth_method === "token" ? "token" : "password";
                let userId;
                try {
                    if (method === "token") {
                        const linked = await options.linker.linkWithToken({
                            country: ctx.body.country ?? "",
                            token: ctx.body.api_v2_auth ?? "",
                        });
                        userId = linked.userId;
                    }
                    else {
                        const linked = await options.linker.linkWithPassword({
                            country: ctx.body.country ?? "",
                            email: ctx.body.email ?? "",
                            password: ctx.body.password ?? "",
                        });
                        userId = linked.userId;
                    }
                }
                catch (error) {
                    const code = (0, log_js_1.errorCode)(error);
                    if (error instanceof hellofresh_api_js_1.HelloFreshApiError && error.code === "rate_limited") {
                        log_js_1.log.warn("oauth.authorize", {
                            outcome: "rate_limited",
                            method,
                            country: ctx.body.country,
                        });
                        return new Response("Too many authorize attempts", { status: 429 });
                    }
                    log_js_1.log.warn("oauth.authorize", {
                        outcome: "rejected",
                        method,
                        country: ctx.body.country,
                        code,
                    });
                    const message = error instanceof hellofresh_api_js_1.HelloFreshApiError
                        ? error.message
                        : "HelloFresh did not accept these credentials.";
                    return renderAuthorize(message);
                }
                const email = `${userId}@${LOCAL_USER_DOMAIN}`;
                const existing = await ctx.context.internalAdapter.findUserByEmail(email);
                const user = existing?.user ??
                    (await ctx.context.internalAdapter.createUser({
                        email,
                        name: "HelloFresh",
                        emailVerified: true,
                        hellofreshUserId: userId,
                    }, { method: "admin" }));
                const session = await ctx.context.internalAdapter.createSession(user.id, false);
                await (0, cookies_1.setSessionCookie)(ctx, { session, user });
                log_js_1.log.info("oauth.authorize", {
                    outcome: "linked",
                    method,
                    country: ctx.body.country,
                    userId,
                    clientId: ctx.query?.client_id,
                });
                return ctx.redirect(`/oauth2/authorize?${query}`);
            }),
            consentPage: (0, api_1.createAuthEndpoint)("/consent", { method: "GET" }, async (ctx) => {
                const query = signedQueryFrom(ctx.request);
                if (!query || !(await (0, oauth_provider_1.verifyOAuthQueryParams)(query, ctx.context.secret))) {
                    return htmlError(400, "Authorization request expired. Start again from the client.");
                }
                try {
                    const result = await options.getAuth().api.oauth2Consent({
                        body: { accept: true, oauth_query: query },
                        headers: ctx.headers ?? ctx.request?.headers ?? new Headers(),
                    });
                    if (result && typeof result === "object" && "url" in result && typeof result.url === "string") {
                        return ctx.redirect(result.url);
                    }
                }
                catch (error) {
                    log_js_1.log.warn("oauth.authorize", {
                        outcome: "rejected",
                        reason: "consent",
                        code: (0, log_js_1.errorCode)(error),
                    });
                }
                return htmlError(400, "Could not complete authorization. Start again from the client.");
            }),
        },
    };
}
async function registerWithAllowlist(auth, request, config) {
    const text = await request.text();
    let body;
    try {
        body = JSON.parse(text);
    }
    catch {
        return Response.json({ error: "invalid_client_metadata", error_description: "Request body must be JSON" }, { status: 400, headers: { "Cache-Control": "no-store" } });
    }
    const redirectUris = Array.isArray(body.redirect_uris)
        ? body.redirect_uris.filter((item) => typeof item === "string")
        : [];
    for (const uri of redirectUris) {
        if (!(0, config_js_1.redirectHostnameAllowed)(uri, config.redirectHosts, config.allowLoopbackRedirects)) {
            log_js_1.log.warn("oauth.register", { outcome: "rejected", reason: "redirect_uri" });
            return Response.json({ error: "invalid_redirect_uri", error_description: `redirect_uri is not allowed: ${uri}` }, { status: 400, headers: { "Cache-Control": "no-store" } });
        }
    }
    const forwarded = new Request(request.url, {
        method: "POST",
        headers: request.headers,
        body: text,
    });
    const response = await auth.handler(forwarded);
    if (response.status !== 201) {
        return response;
    }
    const registered = (await response.json());
    if (typeof registered.client_id === "string") {
        await skipConsentForClient(auth, registered.client_id);
        log_js_1.log.info("oauth.register", {
            clientId: registered.client_id,
            clientName: registered.client_name,
        });
    }
    return Response.json(registered, {
        status: 201,
        headers: {
            "Cache-Control": "no-store",
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": response.headers.get("access-control-allow-origin") ?? "*",
        },
    });
}
async function skipConsentForClient(auth, clientId) {
    const { adapter } = await auth.$context;
    await adapter.update({
        model: "oauthClient",
        where: [{ field: "clientId", value: clientId }],
        update: { skipConsent: true },
    });
}
function signedQueryFrom(request) {
    if (!request) {
        return "";
    }
    return new URL(request.url).search.replace(/^\?/, "");
}
/**
 * Better Auth returns `{ redirect: true, url }` JSON for fetch/CORS clients.
 * OAuth authorize must be an HTTP 302 (RFC 6749 / RFC 9207).
 */
async function asBrowserRedirect(response) {
    if (response.status !== 200) {
        return response;
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
        return response;
    }
    let body;
    try {
        body = JSON.parse(await response.clone().text());
    }
    catch {
        return response;
    }
    if (!body ||
        typeof body !== "object" ||
        body.redirect !== true ||
        typeof body.url !== "string") {
        return response;
    }
    const headers = new Headers(response.headers);
    headers.delete("content-type");
    headers.delete("content-length");
    headers.set("location", body.url);
    return new Response(null, { status: 302, headers });
}
function renderAuthorize(error) {
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
  <form method="post" action="">
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
    return new Response(body, { status: 200, headers: HTML_HEADERS });
}
function htmlError(status, message) {
    const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Authorization error</title></head><body><p>${(0, security_js_1.htmlEscape)(message)}</p></body></html>`;
    return new Response(body, { status, headers: HTML_HEADERS });
}
//# sourceMappingURL=auth-server.js.map