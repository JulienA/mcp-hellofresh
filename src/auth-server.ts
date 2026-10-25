import { createHmac, timingSafeEqual } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { betterAuth } from "better-auth";
import { createAuthEndpoint, getSessionFromCtx } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { jwt } from "better-auth/plugins";
import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { mcp } from "@better-auth/mcp";
import { verifyOAuthQueryParams } from "@better-auth/oauth-provider";
import type { AccountLinker } from "./account-linker.js";
import {
  ACCESS_TOKEN_TTL_SEC,
  AUTH_CODE_TTL_SEC,
  MCP_SCOPE,
  REFRESH_TOKEN_TTL_SEC,
  redirectHostnameAllowed,
  type HttpRuntimeConfig,
} from "./config.js";
import { HELLOFRESH_COUNTRIES } from "./countries.js";
import { HelloFreshApiError } from "./hellofresh-api.js";
import { errorCode, log } from "./log.js";
import { htmlEscape } from "./security.js";
import { z } from "zod";

const LOCAL_USER_DOMAIN = "users.local";
const HTML_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
};

export interface AuthorizationServer {
  handler: (request: Request) => Promise<Response>;
  jwksUrl: URL;
  issuer: string;
  close: () => void;
}

export interface AuthorizationServerOptions {
  accessTokenExpiresIn?: number;
}

export async function createAuthorizationServer(
  config: HttpRuntimeConfig,
  linker: AccountLinker,
  options: AuthorizationServerOptions = {}
): Promise<AuthorizationServer> {
  const issuer = config.issuer.origin;
  const resource = config.resourceUrl.href;
  const secret = config.authSecret;
  if (secret.length < 32) {
    throw new Error("BETTER_AUTH_SECRET or MCP_DATA_KEY must be at least 32 characters.");
  }
  await mkdir(dirname(config.authDbPath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(config.authDbPath);
  const authRef: { current?: AuthInstance } = {};

  const auth = betterAuth({
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
      jwt({
        disableSettingJwtHeader: true,
        jwt: { issuer },
        jwks: { keyPairConfig: { alg: "EdDSA" } },
      }),
      mcp({
        loginPage: "/sign-in",
        consentPage: "/consent",
        resource,
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        clientRegistrationDefaultApplicationType: "infer",
        scopes: [MCP_SCOPE, "openid", "offline_access"],
        grantTypes: ["authorization_code", "refresh_token"],
        accessTokenExpiresIn: options.accessTokenExpiresIn ?? ACCESS_TOKEN_TTL_SEC,
        refreshTokenExpiresIn: REFRESH_TOKEN_TTL_SEC,
        codeExpiresIn: AUTH_CODE_TTL_SEC,
        refreshTokenReuseInterval: 0,
        rateLimit: {
          register: { window: 60, max: 20 },
        },
        customAccessTokenClaims: ({ user }) => {
          const userId = user?.hellofreshUserId;
          return typeof userId === "string" && userId ? { userId } : {};
        },
        validateRedirectUri: (redirectUri, _registered, defaultResult) =>
          defaultResult &&
          redirectHostnameAllowed(redirectUri, config.redirectHosts, config.allowLoopbackRedirects),
      }),
      cimd({
        fetchClientMetadataResource,
        metadataProfile: "mcp-2026-07-28",
      }),
      helloFreshInteractionPlugin({
        linker,
        getAuth: () => authRef.current!,
      }),
    ],
  });
  authRef.current = auth as AuthInstance;

  const ctx = await auth.$context;
  await ctx.runMigrations();
  clearStoredSkipConsent(db);
  await chmod(config.authDbPath, 0o600).catch(() => undefined);

  const handler = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname === "/oauth2/register" && request.method === "POST") {
      return registerWithAllowlist(auth as AuthInstance, request, config);
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

export function isAuthorizationServerPath(pathname: string): boolean {
  const path = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  return (
    path === "/sign-in" ||
    path === "/consent" ||
    path === "/jwks" ||
    path === "/.well-known/oauth-authorization-server" ||
    path === "/.well-known/openid-configuration" ||
    path.startsWith("/oauth2/")
  );
}

type AuthInstance = {
  handler: (request: Request) => Promise<Response>;
  $context: Promise<{
    runMigrations: () => Promise<void>;
    internalAdapter: {
      findUserByEmail: (email: string) => Promise<{ user: UserRecord } | null>;
      createUser: (
        user: {
          email: string;
          name: string;
          emailVerified: boolean;
          hellofreshUserId: string;
        },
        source: { method: string }
      ) => Promise<UserRecord>;
      createSession: (userId: string, dontRememberMe?: boolean) => Promise<SessionRecord>;
    };
    secret: string;
  }>;
};

type UserRecord = {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  email: string;
  emailVerified: boolean;
  name: string;
  image?: string | null;
  hellofreshUserId?: string;
} & Record<string, unknown>;

type SessionRecord = {
  id: string;
  token: string;
  userId: string;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
} & Record<string, unknown>;

function helloFreshInteractionPlugin(options: {
  linker: AccountLinker;
  getAuth: () => AuthInstance;
}) {
  return {
    id: "hellofresh-sign-in",
    endpoints: {
      signInPage: createAuthEndpoint(
        "/sign-in",
        { method: "GET" },
        async (ctx) => {
          const query = signedQueryFrom(ctx.request);
          if (!query || !(await verifyOAuthQueryParams(query, ctx.context.secret))) {
            log.warn("oauth.authorize", { outcome: "rejected", reason: "query" });
            return htmlError(400, "Authorization request expired. Start again from the client.");
          }
          log.info("oauth.authorize", { outcome: "form", clientId: ctx.query?.client_id });
          return renderAuthorize();
        }
      ),
      signInSubmit: createAuthEndpoint(
        "/sign-in",
        {
          method: "POST",
          metadata: {
            allowedMediaTypes: ["application/x-www-form-urlencoded"],
          },
          body: z.object({
            auth_method: z.string().optional(),
            country: z.string().optional(),
            email: z.string().optional(),
            password: z.string().optional(),
            api_v2_auth: z.string().optional(),
          }),
        },
        async (ctx) => {
          const query = signedQueryFrom(ctx.request);
          if (!query || !(await verifyOAuthQueryParams(query, ctx.context.secret))) {
            log.warn("oauth.authorize", { outcome: "expired" });
            return htmlError(400, "Authorization request expired. Start again from the client.");
          }

          const method = ctx.body.auth_method === "token" ? "token" : "password";
          let userId: string;
          try {
            if (method === "token") {
              const linked = await options.linker.linkWithToken({
                country: ctx.body.country ?? "",
                token: ctx.body.api_v2_auth ?? "",
              });
              userId = linked.userId;
            } else {
              const linked = await options.linker.linkWithPassword({
                country: ctx.body.country ?? "",
                email: ctx.body.email ?? "",
                password: ctx.body.password ?? "",
              });
              userId = linked.userId;
            }
          } catch (error) {
            const code = errorCode(error);
            if (error instanceof HelloFreshApiError && error.code === "rate_limited") {
              log.warn("oauth.authorize", {
                outcome: "rate_limited",
                method,
                country: ctx.body.country,
              });
              return new Response("Too many authorize attempts", { status: 429 });
            }
            log.warn("oauth.authorize", {
              outcome: "rejected",
              method,
              country: ctx.body.country,
              code,
            });
            const message =
              error instanceof HelloFreshApiError
                ? error.message
                : "HelloFresh did not accept these credentials.";
            return renderAuthorize(message);
          }

          const email = `${userId}@${LOCAL_USER_DOMAIN}`;
          const existing = await ctx.context.internalAdapter.findUserByEmail(email);
          const user =
            existing?.user ??
            (await ctx.context.internalAdapter.createUser(
              {
                email,
                name: "HelloFresh",
                emailVerified: true,
                hellofreshUserId: userId,
              },
              { method: "admin" }
            ));
          const session = await ctx.context.internalAdapter.createSession(user.id, false);
          await setSessionCookie(ctx, { session, user });
          log.info("oauth.authorize", {
            outcome: "linked",
            method,
            country: ctx.body.country,
            userId,
            clientId: ctx.query?.client_id,
          });
          return ctx.redirect(`/oauth2/authorize?${query}`);
        }
      ),
      consentPage: createAuthEndpoint(
        "/consent",
        { method: "GET" },
        async (ctx) => {
          const query = signedQueryFrom(ctx.request);
          if (!query || !(await verifyOAuthQueryParams(query, ctx.context.secret))) {
            return htmlError(400, "Authorization request expired. Start again from the client.");
          }
          const sessionId = await sessionIdFrom(ctx);
          if (!sessionId) {
            return ctx.redirect(`/sign-in?${query}`);
          }
          log.info("oauth.authorize", {
            outcome: "consent",
            clientId: clientIdFromQuery(query),
          });
          return renderConsent(query, consentNonce(ctx.context.secret, sessionId, query));
        }
      ),
      consentSubmit: createAuthEndpoint(
        "/consent",
        {
          method: "POST",
          metadata: {
            allowedMediaTypes: ["application/x-www-form-urlencoded"],
          },
          body: z.object({
            nonce: z.string().optional(),
            decision: z.string().optional(),
          }),
        },
        async (ctx) => {
          const query = signedQueryFrom(ctx.request);
          if (!query || !(await verifyOAuthQueryParams(query, ctx.context.secret))) {
            return htmlError(400, "Authorization request expired. Start again from the client.");
          }
          const sessionId = await sessionIdFrom(ctx);
          if (!sessionId) {
            return ctx.redirect(`/sign-in?${query}`);
          }
          const expected = consentNonce(ctx.context.secret, sessionId, query);
          if (!csrfMatches(expected, ctx.body.nonce ?? "")) {
            log.warn("oauth.authorize", { outcome: "rejected", reason: "consent_csrf" });
            return htmlError(400, "Could not complete authorization. Start again from the client.");
          }
          const accept = ctx.body.decision === "allow";
          if (!accept && ctx.body.decision !== "deny") {
            return htmlError(400, "Could not complete authorization. Start again from the client.");
          }
          const request = ctx.request;
          if (!request) {
            return htmlError(400, "Could not complete authorization. Start again from the client.");
          }
          try {
            const completed = await completeOAuthConsent(options.getAuth(), request, query, accept);
            if (completed.status === 302 || completed.status === 303) {
              const location = completed.headers.get("location");
              if (location) {
                log.info("oauth.authorize", {
                  outcome: accept ? "accepted" : "denied",
                  clientId: clientIdFromQuery(query),
                });
                return ctx.redirect(location);
              }
            }
            log.warn("oauth.authorize", {
              outcome: "rejected",
              reason: "consent",
              status: completed.status,
            });
          } catch (error) {
            log.warn("oauth.authorize", {
              outcome: "rejected",
              reason: "consent",
              code: errorCode(error),
            });
          }
          return htmlError(400, "Could not complete authorization. Start again from the client.");
        }
      ),
    },
  };
}

async function registerWithAllowlist(
  auth: AuthInstance,
  request: Request,
  config: HttpRuntimeConfig
): Promise<Response> {
  const text = await request.text();
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return Response.json(
      { error: "invalid_client_metadata", error_description: "Request body must be JSON" },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }
  const redirectUris = Array.isArray(body.redirect_uris)
    ? body.redirect_uris.filter((item): item is string => typeof item === "string")
    : [];
  for (const uri of redirectUris) {
    if (!redirectHostnameAllowed(uri, config.redirectHosts, config.allowLoopbackRedirects)) {
      log.warn("oauth.register", { outcome: "rejected", reason: "redirect_uri" });
      return Response.json(
        { error: "invalid_redirect_uri", error_description: `redirect_uri is not allowed: ${uri}` },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      );
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
  const registered = (await response.json()) as { client_id?: string; client_name?: string };
  if (typeof registered.client_id === "string") {
    log.info("oauth.register", {
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

function clearStoredSkipConsent(db: DatabaseSync): void {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
    name: string;
  }>;
  const table = tables.map((row) => row.name).find((name) => name === "oauthClient" || name === "oauth_client");
  if (!table) {
    return;
  }
  const columns = db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>;
  const column = columns
    .map((row) => row.name)
    .find((name) => name === "skipConsent" || name === "skip_consent");
  if (!column) {
    return;
  }
  db.exec(`UPDATE "${table}" SET "${column}" = 0`);
}

function signedQueryFrom(request: Request | undefined): string {
  if (!request) {
    return "";
  }
  return new URL(request.url).search.replace(/^\?/, "");
}

async function sessionIdFrom(ctx: Parameters<typeof getSessionFromCtx>[0]): Promise<string> {
  const session = await getSessionFromCtx(ctx, { disableRefresh: true });
  const id = session?.session?.id;
  return typeof id === "string" ? id : "";
}

function clientIdFromQuery(query: string): string | undefined {
  return new URLSearchParams(query).get("client_id") ?? undefined;
}

function consentNonce(secret: string, sessionId: string, query: string): string {
  return createHmac("sha256", secret).update(sessionId).update("\0").update(query).digest("base64url");
}

async function completeOAuthConsent(
  auth: AuthInstance,
  request: Request,
  query: string,
  accept: boolean
): Promise<Response> {
  const headers = new Headers();
  const cookie = request.headers.get("cookie");
  if (cookie) {
    headers.set("cookie", cookie);
  }
  const origin = request.headers.get("origin");
  if (origin) {
    headers.set("origin", origin);
  }
  const referer = request.headers.get("referer");
  if (referer) {
    headers.set("referer", referer);
  }
  headers.set("content-type", "application/json");
  headers.set("accept", "application/json");
  return asBrowserRedirect(
    await auth.handler(
      new Request(new URL("/oauth2/consent", request.url), {
        method: "POST",
        headers,
        body: JSON.stringify({ accept, oauth_query: query }),
      })
    )
  );
}

function csrfMatches(expected: string, provided: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(provided);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Better Auth returns `{ redirect: true, url }` JSON for fetch/CORS clients.
 * OAuth authorize must be an HTTP 302 (RFC 6749 / RFC 9207).
 */
async function asBrowserRedirect(response: Response): Promise<Response> {
  if (response.status !== 200) {
    return response;
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return response;
  }
  let body: unknown;
  try {
    body = JSON.parse(await response.clone().text());
  } catch {
    return response;
  }
  if (
    !body ||
    typeof body !== "object" ||
    (body as { redirect?: unknown }).redirect !== true ||
    typeof (body as { url?: unknown }).url !== "string"
  ) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.delete("content-type");
  headers.delete("content-length");
  headers.set("location", (body as { url: string }).url);
  return new Response(null, { status: 302, headers });
}

function renderConsent(query: string, nonce: string): Response {
  const params = new URLSearchParams(query);
  const clientId = params.get("client_id") ?? "";
  const redirectUri = params.get("redirect_uri") ?? "";
  const body = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Allow this connector</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 32rem; margin: 3rem auto; padding: 0 1rem; color: #111; }
    code { background: #f4f4f4; padding: 0.1rem 0.3rem; word-break: break-all; }
    button { padding: 0.5rem 1rem; margin-right: 0.5rem; }
    .note { color: #444; font-size: 0.9rem; }
  </style>
</head>
<body>
  <h1>Allow this connector?</h1>
  <p>This lets the app use your HelloFresh account on this server. It cannot see your HelloFresh password.</p>
  <p class="note">Client <code>${htmlEscape(clientId)}</code></p>
  <p class="note">Redirect <code>${htmlEscape(redirectUri)}</code></p>
  <form method="post" action="/consent?${htmlEscape(query)}">
    <input type="hidden" name="nonce" value="${htmlEscape(nonce)}">
    <p>
      <button type="submit" name="decision" value="allow">Allow</button>
      <button type="submit" name="decision" value="deny">Deny</button>
    </p>
  </form>
</body>
</html>`;
  return new Response(body, { status: 200, headers: HTML_HEADERS });
}

function renderAuthorize(error?: string): Response {
  const options = HELLOFRESH_COUNTRIES.map(
    (country) => `<option value="${htmlEscape(country.code)}">${htmlEscape(country.label)}</option>`
  ).join("");
  const errorBlock = error ? `<p class="error">${htmlEscape(error)}</p>` : "";
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

function htmlError(status: number, message: string): Response {
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Authorization error</title></head><body><p>${htmlEscape(message)}</p></body></html>`;
  return new Response(body, { status, headers: HTML_HEADERS });
}
