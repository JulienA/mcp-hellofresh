import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { readStoredAccount, userIdFor } from "./accounts.js";
import { ACCESS_TOKEN_TTL_SEC, type HttpRuntimeConfig } from "./config.js";
import { clearRecipeDetailsCache, type FetchLike } from "./hellofresh-api.js";
import { startHttpServer, type HttpServerHandle } from "./http.js";
import { captureLogLines, setLogLevel, setLogSink } from "./log.js";
import { OAuthStore } from "./oauth-store.js";
import { DATA_KEY_ENV } from "./secret-box.js";

process.env[DATA_KEY_ENV] = Buffer.alloc(32, 0x11).toString("base64url");

setLogSink(() => {});

const CORRECT_PASSWORD = "correct-hf-password";
const TINY_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const CLAUDE_REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const WEEK = "2099-W01";

interface RecordedCall {
  method: string;
  url: string;
  authorization: string;
  body: string;
}

function jwt(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${header}.${payload}.sig`;
}

function headerValue(headers: HeadersInit | undefined, name: string): string {
  if (!headers) {
    return "";
  }
  if (headers instanceof Headers) {
    return headers.get(name) ?? "";
  }
  if (Array.isArray(headers)) {
    const found = headers.find(([key]) => key.toLowerCase() === name.toLowerCase());
    return found?.[1] ?? "";
  }
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) {
      return value;
    }
  }
  return "";
}

function scriptedHelloFresh(calls: RecordedCall[]): FetchLike {
  return async (input, init) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? init.body : "";
    const authorization = headerValue(init?.headers, "authorization");
    calls.push({ method: init?.method ?? "GET", url, authorization, body });

    if (url.includes("/gw/login")) {
      const parsed = JSON.parse(body) as { username?: string; password?: string };
      if (parsed.password !== CORRECT_PASSWORD) {
        return Response.json({ message: "invalid" }, { status: 401 });
      }
      return Response.json({
        access_token: `hf-access-${parsed.username}`,
        refresh_token: `hf-refresh-${parsed.username}`,
        expires_in: 1800,
        refresh_expires_in: 5_000_000,
        token_type: "Bearer",
      });
    }
    if (url.includes("/gw/refresh")) {
      const parsed = JSON.parse(body) as { refresh_token?: string };
      return Response.json({
        access_token: `hf-access-refreshed-${parsed.refresh_token}`,
        refresh_token: parsed.refresh_token,
        expires_in: 1800,
        token_type: "Bearer",
      });
    }
    if (url.includes("/customers/me/subscriptions")) {
      return Response.json({
        items: [
          {
            id: "sub-1",
            customerPlanId: "plan-1",
            customer: { id: "cust-1" },
            preset: "chefschoice",
            locale: "fr-FR",
            shippingAddress: { postcode: "75011" },
            deliveryOption: { handle: "FR-1-0800-1600" },
            product: { sku: "FR-CBT-3-2-0", specs: { meals: 3, size: 2 } },
            deliveryInterval: 1,
            status: "active",
          },
        ],
      });
    }
    if (url.includes("/customers/me/info")) {
      if (authorization.startsWith("Bearer hf-access-") && !authorization.includes("refreshed-")) {
        const email = authorization.slice("Bearer hf-access-".length);
        if (email.startsWith("refreshed-")) {
          return Response.json({ email: "paste@example.com" });
        }
        return Response.json({ email });
      }
      if (authorization.includes("no-email-token")) {
        return Response.json({});
      }
      return Response.json({ email: "paste@example.com" });
    }
    if (url.includes("/recipes/recipes/")) {
      return Response.json({
        id: "recipe-1",
        name: "Tacos",
        headline: "Crispy",
        imagePath: "/image/tacos.jpg",
        prepTime: "PT25M",
        ingredients: [{ id: "chicken", name: "Poulet" }],
        yields: [{ yields: 2, ingredients: [{ id: "chicken", amount: 1, unit: "pièce" }] }],
        steps: [{ instructions: "Dorer le <b>poulet</b>." }],
        nutrition: [{ name: "Énergie (kcal)", amount: 640, unit: "kcal" }],
        allergens: [{ name: "Lait" }],
      });
    }
    if (url.startsWith("https://img.hellofresh.com/")) {
      return new Response(TINY_JPEG, { headers: { "content-type": "image/jpeg" } });
    }
    if (url.includes("/my-deliveries/menu")) {
      return Response.json({
        week: new URL(url).searchParams.get("week") ?? WEEK,
        meals: [
          {
            index: 1,
            recipe: {
              id: "recipe-1",
              name: "Tacos",
              headline: "Crispy",
              imagePath: "/image/tacos.jpg",
            },
          },
        ],
      });
    }
    if (url.includes("/customers/me/deliveries")) {
      return Response.json({
        items: [
          {
            id: WEEK,
            deliveryDate: "2099-01-06T00:00:00+0000",
            cutoffDate: "2099-01-04T23:59:59+0000",
            status: "RUNNING",
            subscriptionId: "sub-1",
            product: { handle: "FR-CBT-3-2-0" },
          },
        ],
      });
    }
    return Response.json({ message: "not used" }, { status: 404 });
  };
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function localConfig(overrides: Partial<HttpRuntimeConfig> = {}): HttpRuntimeConfig {
  const issuer = new URL("http://127.0.0.1");
  return {
    host: "127.0.0.1",
    port: 0,
    publicBaseUrl: issuer,
    issuer,
    resourceUrl: new URL("/mcp", issuer),
    oauthStorePath: "/tmp/unused-oauth-store.json",
    usersDir: "/tmp/unused-users",
    redirectHosts: ["claude.ai", "claude.com", "chatgpt.com"],
    allowLoopbackRedirects: true,
    authorizeMaxAttempts: 10,
    authorizeWindowMs: 15 * 60 * 1000,
    dangerouslyAllowInsecureIssuerUrl: true,
    ...overrides,
  };
}

async function readJsonOrSse(response: Response): Promise<unknown> {
  const text = await response.text();
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return JSON.parse(trimmed);
  }
  const dataLines = text
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((line) => line.length > 0 && line !== "[DONE]");
  const last = dataLines.at(-1);
  assert.ok(last, `expected JSON or SSE payload, got: ${text.slice(0, 300)}`);
  return JSON.parse(last);
}

async function withServer(
  overrides: Partial<HttpRuntimeConfig>,
  fn: (handle: HttpServerHandle, calls: RecordedCall[]) => Promise<void>
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "mcp-oauth-"));
  const oauthStorePath = overrides.oauthStorePath ?? join(dir, "oauth-store.json");
  const usersDir = overrides.usersDir ?? join(dirname(oauthStorePath), "users");
  const calls: RecordedCall[] = [];
  const handle = await startHttpServer(localConfig({ ...overrides, oauthStorePath, usersDir }), {
    fetchImpl: scriptedHelloFresh(calls),
  });
  try {
    await fn(handle, calls);
  } finally {
    await handle.close();
  }
}

async function registerClient(
  baseUrl: string,
  redirectUri = CLAUDE_REDIRECT
): Promise<{ client_id: string }> {
  const response = await fetch(`${baseUrl}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "test-client",
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  const text = await response.text();
  assert.equal(response.status, 201, text);
  return JSON.parse(text) as { client_id: string };
}

async function authorizeForm(handle: HttpServerHandle, clientId: string, challenge: string): Promise<string> {
  const authorize = new URL("/authorize", handle.baseUrl);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("redirect_uri", CLAUDE_REDIRECT);
  authorize.searchParams.set("code_challenge", challenge);
  authorize.searchParams.set("code_challenge_method", "S256");
  authorize.searchParams.set("state", "xyz");
  authorize.searchParams.set("resource", handle.config.resourceUrl.href);
  authorize.searchParams.set("scope", "mcp");
  const form = await fetch(authorize);
  assert.equal(form.status, 200);
  const html = await form.text();
  assert.doesNotMatch(html, /Owner secret/);
  assert.match(html, /apiV2Auth/);
  assert.match(html, /Do not type a Google password/);
  assert.doesNotMatch(html, /name="google_password"/);
  const requestId = /name="request_id" value="([^"]+)"/.exec(html)?.[1];
  assert.ok(requestId);
  return requestId;
}

async function completePkce(
  handle: HttpServerHandle,
  options: { email?: string; password?: string; country?: string } = {}
): Promise<{ accessToken: string; refreshToken: string; clientId: string; email: string }> {
  const email = options.email ?? "alice@example.com";
  const { client_id: clientId } = await registerClient(handle.baseUrl);
  const { verifier, challenge } = pkce();
  const resource = handle.config.resourceUrl.href;
  const requestId = await authorizeForm(handle, clientId, challenge);

  const submitted = await fetch(`${handle.baseUrl}/authorize`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      request_id: requestId,
      auth_method: "password",
      country: options.country ?? "fr",
      email,
      password: options.password ?? CORRECT_PASSWORD,
    }),
    redirect: "manual",
  });
  assert.equal(submitted.status, 302, await submitted.clone().text());
  const location = submitted.headers.get("location");
  assert.ok(location);
  const redirected = new URL(location);
  assert.equal(redirected.origin + redirected.pathname, new URL(CLAUDE_REDIRECT).origin + new URL(CLAUDE_REDIRECT).pathname);
  assert.equal(redirected.searchParams.get("iss"), handle.config.issuer.origin);
  assert.equal(redirected.searchParams.get("state"), "xyz");
  const code = redirected.searchParams.get("code");
  assert.ok(code);

  const token = await fetch(`${handle.baseUrl}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: CLAUDE_REDIRECT,
      client_id: clientId,
      code_verifier: verifier,
      resource,
    }),
  });
  assert.equal(token.status, 200, await token.clone().text());
  const body = (await token.json()) as {
    access_token: string;
    refresh_token: string;
    token_type: string;
    expires_in: number;
    scope: string;
  };
  assert.equal(body.token_type, "Bearer");
  assert.equal(body.expires_in, ACCESS_TOKEN_TTL_SEC);
  assert.equal(body.scope, "mcp");
  return { accessToken: body.access_token, refreshToken: body.refresh_token, clientId, email };
}

async function toolCall(
  handle: HttpServerHandle,
  accessToken: string,
  name: string,
  args: unknown
): Promise<{ isError?: boolean; content?: Array<{ type?: string; text?: string; data?: string; mimeType?: string }> }> {
  const response = await fetch(`${handle.baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  const rpc = (await readJsonOrSse(response)) as {
    result?: { isError?: boolean; content?: Array<{ type?: string; text?: string; data?: string; mimeType?: string }> };
    error?: { message: string };
  };
  if (rpc.error) {
    return { isError: true, content: [{ type: "text", text: rpc.error.message }] };
  }
  return rpc.result ?? {};
}

async function toolText(handle: HttpServerHandle, accessToken: string, name: string, args: unknown): Promise<string> {
  const result = await toolCall(handle, accessToken, name, args);
  return result.content?.[0]?.text ?? JSON.stringify(result);
}

describe("HTTP health and OAuth metadata", () => {
  it("serves /healthz and RFC 9728 / RFC 8414 documents", async () => {
    await withServer({}, async (handle) => {
      const health = await fetch(`${handle.baseUrl}/healthz`);
      assert.equal(health.status, 200);
      assert.deepEqual(await health.json(), { ok: true });

      const prm = await fetch(`${handle.baseUrl}/.well-known/oauth-protected-resource/mcp`);
      assert.equal(prm.status, 200, await prm.clone().text());
      const prmBody = (await prm.json()) as {
        resource: string;
        authorization_servers: string[];
      };
      assert.equal(prmBody.resource, handle.config.resourceUrl.href);
      assert.deepEqual(prmBody.authorization_servers, [handle.config.issuer.origin]);

      const as = await fetch(`${handle.baseUrl}/.well-known/oauth-authorization-server`);
      assert.equal(as.status, 200);
      const asBody = (await as.json()) as {
        issuer: string;
        authorization_endpoint: string;
        token_endpoint: string;
        registration_endpoint: string;
        code_challenge_methods_supported: string[];
        grant_types_supported: string[];
      };
      assert.equal(asBody.issuer, handle.config.issuer.origin);
      assert.equal(asBody.authorization_endpoint, `${handle.baseUrl}/authorize`);
      assert.equal(asBody.token_endpoint, `${handle.baseUrl}/token`);
      assert.equal(asBody.registration_endpoint, `${handle.baseUrl}/register`);
      assert.deepEqual(asBody.code_challenge_methods_supported, ["S256"]);
      assert.ok(asBody.grant_types_supported.includes("authorization_code"));
      assert.ok(asBody.grant_types_supported.includes("refresh_token"));
    });
  });
});

describe("OAuth DCR + PKCE + refresh", () => {
  it("registers a client, exchanges a PKCE code, and keeps userId on refresh", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-oauth-"));
    const storePath = join(dir, "oauth-store.json");
    await withServer({ oauthStorePath: storePath }, async (handle) => {
      const tokens = await completePkce(handle, { email: "alice@example.com" });
      assert.match(tokens.accessToken, /^mcp_/);

      const rawStore = await readFile(storePath, "utf8");
      assert.equal(rawStore.includes(tokens.accessToken), false);
      assert.equal(rawStore.includes(tokens.refreshToken), false);
      assert.equal(rawStore.includes("alice@example.com"), false);
      assert.match(rawStore, /aes-256-gcm/);
      assert.equal((await stat(storePath)).mode & 0o777, 0o600);
      assert.equal(rawStore.includes(CORRECT_PASSWORD), false);

      const access = await new OAuthStore(storePath).getToken(tokens.accessToken);
      assert.equal(access?.kind, "access");
      assert.equal(access && access.kind === "access" ? access.userId : "", userIdFor("fr", "alice@example.com"));

      const refreshed = await fetch(`${handle.baseUrl}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: tokens.refreshToken,
          client_id: tokens.clientId,
          resource: handle.config.resourceUrl.href,
        }),
      });
      assert.equal(refreshed.status, 200, await refreshed.clone().text());
      const next = (await refreshed.json()) as {
        access_token: string;
        refresh_token: string;
      };
      assert.notEqual(next.access_token, tokens.accessToken);
      assert.notEqual(next.refresh_token, tokens.refreshToken);
      const rotated = await new OAuthStore(storePath).getToken(next.access_token);
      assert.equal(rotated?.kind, "access");
      assert.equal(
        rotated && rotated.kind === "access" ? rotated.userId : "",
        userIdFor("fr", "alice@example.com")
      );

      const reuse = await fetch(`${handle.baseUrl}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: tokens.refreshToken,
          client_id: tokens.clientId,
        }),
      });
      assert.equal(reuse.status, 400);
    });
  });

  it("rejects a redirect_uri that is not on the allowlist", async () => {
    await withServer({}, async (handle) => {
      const response = await fetch(`${handle.baseUrl}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          redirect_uris: ["https://evil.example/callback"],
        }),
      });
      assert.equal(response.status, 400);
      const body = (await response.json()) as { error: string };
      assert.equal(body.error, "invalid_redirect_uri");
    });
  });

  it("rate-limits the authorize form and redisplays a bad password", async () => {
    await withServer({ authorizeMaxAttempts: 2, authorizeWindowMs: 60_000 }, async (handle) => {
      const { client_id } = await registerClient(handle.baseUrl);
      const { challenge } = pkce();
      const requestId = await authorizeForm(handle, client_id, challenge);
      for (let i = 0; i < 2; i += 1) {
        const denied = await fetch(`${handle.baseUrl}/authorize`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            request_id: requestId,
            auth_method: "password",
            country: "fr",
            email: "limited@example.com",
            password: "wrong-password-value",
          }),
        });
        assert.equal(denied.status, 200);
        const html = await denied.text();
        assert.match(html, /did not accept these credentials/i);
        assert.doesNotMatch(html, /wrong-password-value/);
        assert.doesNotMatch(html, /Owner secret/);
      }
      const limited = await fetch(`${handle.baseUrl}/authorize`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          request_id: requestId,
          auth_method: "password",
          country: "fr",
          email: "limited@example.com",
          password: "wrong-password-value",
        }),
      });
      assert.equal(limited.status, 429);
      const entries = await readdir(handle.config.usersDir).catch((error: NodeJS.ErrnoException) => {
        assert.equal(error.code, "ENOENT");
        return [] as string[];
      });
      assert.deepEqual(entries, []);
    });
  });

  it("rejects a wrong PKCE verifier after a real HelloFresh sign-in", async () => {
    await withServer({}, async (handle) => {
      const { client_id } = await registerClient(handle.baseUrl);
      const { challenge } = pkce();
      const requestId = await authorizeForm(handle, client_id, challenge);
      const submitted = await fetch(`${handle.baseUrl}/authorize`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          request_id: requestId,
          auth_method: "password",
          country: "fr",
          email: "alice@example.com",
          password: CORRECT_PASSWORD,
        }),
        redirect: "manual",
      });
      const code = new URL(submitted.headers.get("location") ?? "").searchParams.get("code");
      assert.ok(code);
      const token = await fetch(`${handle.baseUrl}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: CLAUDE_REDIRECT,
          client_id,
          code_verifier: "a".repeat(43),
        }),
      });
      assert.equal(token.status, 400);
      const body = (await token.json()) as { error: string };
      assert.equal(body.error, "invalid_grant");
    });
  });

  it("does not create a code or token file for a bad password", async () => {
    await withServer({}, async (handle) => {
      const { client_id } = await registerClient(handle.baseUrl);
      const { challenge } = pkce();
      const requestId = await authorizeForm(handle, client_id, challenge);
      const submitted = await fetch(`${handle.baseUrl}/authorize`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          request_id: requestId,
          auth_method: "password",
          country: "fr",
          email: "alice@example.com",
          password: "wrong-password-value",
        }),
        redirect: "manual",
      });
      assert.equal(submitted.status, 200);
      assert.equal(submitted.headers.get("location"), null);
      const entries = await readdir(handle.config.usersDir).catch(() => []);
      assert.deepEqual(entries, []);
    });
  });

  it("links a pasted apiV2Auth only after subscriptions succeed", async () => {
    await withServer({}, async (handle, calls) => {
      const { client_id } = await registerClient(handle.baseUrl);
      const { challenge } = pkce();
      const requestId = await authorizeForm(handle, client_id, challenge);
      const access = jwt({ email: "paste@example.com", iat: 1_700_000_000, exp: 1_800_000_000 });
      const pasted = JSON.stringify({
        access_token: access,
        refresh_token: "refresh-paste",
        expires_in: 1800,
        noise: "discard-me-paste-blob",
      });
      calls.length = 0;
      const submitted = await fetch(`${handle.baseUrl}/authorize`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          request_id: requestId,
          auth_method: "token",
          country: "fr",
          api_v2_auth: pasted,
        }),
        redirect: "manual",
      });
      assert.equal(submitted.status, 302, await submitted.clone().text());
      const subscriptionIndex = calls.findIndex((call) => call.url.includes("/customers/me/subscriptions"));
      assert.ok(subscriptionIndex >= 0);
      assert.equal(calls.some((call) => call.url.includes("/gw/login")), false);
      const userId = userIdFor("fr", "paste@example.com");
      const file = join(handle.config.usersDir, userId, "tokens.json");
      const raw = await readFile(file, "utf8");
      assert.equal((await stat(file)).mode & 0o777, 0o600);
      assert.equal(raw.includes("discard-me-paste-blob"), false);
      assert.equal(raw.includes(CORRECT_PASSWORD), false);
      assert.equal(raw.includes("paste@example.com"), false);
      assert.equal(raw.includes(access), false);
      assert.equal(raw.includes("refresh-paste"), false);
      const stored = await readStoredAccount(file);
      assert.equal(stored?.email, "paste@example.com");
      assert.ok(stored?.accessToken);
      assert.equal(raw.includes(stored.accessToken), false);
    });
  });
});

describe("/mcp authentication", () => {
  const mcpHeaders = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };

  const initializeBody = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "oauth-test", version: "0.0.1" },
    },
  };

  it("rejects unauthenticated and static bearer tokens", async () => {
    await withServer({}, async (handle) => {
      const unauth = await fetch(`${handle.baseUrl}/mcp`, {
        method: "POST",
        headers: mcpHeaders,
        body: JSON.stringify(initializeBody),
      });
      assert.equal(unauth.status, 401);
      const challenge = unauth.headers.get("www-authenticate") ?? "";
      assert.match(challenge, /resource_metadata/i);

      const bad = await fetch(`${handle.baseUrl}/mcp`, {
        method: "POST",
        headers: {
          ...mcpHeaders,
          Authorization: "Bearer not-a-real-token",
        },
        body: JSON.stringify(initializeBody),
      });
      assert.equal(bad.status, 401);

      const { accessToken } = await completePkce(handle);
      const ok = await fetch(`${handle.baseUrl}/mcp`, {
        method: "POST",
        headers: {
          ...mcpHeaders,
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(initializeBody),
      });
      assert.equal(ok.status, 200, await ok.clone().text());
      const rpc = (await readJsonOrSse(ok)) as { result?: { serverInfo?: { name: string } } };
      assert.equal(rpc.result?.serverInfo?.name, "@striderlabs/mcp-hellofresh");
    });
  });

  it("keeps two HelloFresh accounts on separate tokens and bearers", async () => {
    await withServer({}, async (handle, calls) => {
      const alice = await completePkce(handle, { email: "alice@example.com" });
      const bob = await completePkce(handle, { email: "bob@example.com" });
      const oauth = new OAuthStore(handle.config.oauthStorePath);
      const aliceAccess = await oauth.getToken(alice.accessToken);
      const bobAccess = await oauth.getToken(bob.accessToken);
      assert.equal(aliceAccess?.kind, "access");
      assert.equal(bobAccess?.kind, "access");
      const aliceId = aliceAccess && aliceAccess.kind === "access" ? aliceAccess.userId : "";
      const bobId = bobAccess && bobAccess.kind === "access" ? bobAccess.userId : "";
      assert.equal(aliceId, userIdFor("fr", "alice@example.com"));
      assert.equal(bobId, userIdFor("fr", "bob@example.com"));
      assert.notEqual(aliceId, bobId);

      const alicePath = join(handle.config.usersDir, aliceId, "tokens.json");
      const bobPath = join(handle.config.usersDir, bobId, "tokens.json");
      const aliceFile = await readFile(alicePath, "utf8");
      const bobFile = await readFile(bobPath, "utf8");
      assert.equal(aliceFile.includes("hf-access-alice@example.com"), false);
      assert.equal(aliceFile.includes("alice@example.com"), false);
      assert.equal(bobFile.includes("hf-access-bob@example.com"), false);
      assert.equal(bobFile.includes("bob@example.com"), false);
      assert.equal(aliceFile.includes(CORRECT_PASSWORD), false);
      const aliceAccount = await readStoredAccount(alicePath);
      const bobAccount = await readStoredAccount(bobPath);
      assert.equal(aliceAccount?.accessToken, "hf-access-alice@example.com");
      assert.equal(bobAccount?.accessToken, "hf-access-bob@example.com");

      const aliceStatus = await toolText(handle, alice.accessToken, "auth_status", {});
      const bobStatus = await toolText(handle, bob.accessToken, "auth_status", {});
      assert.match(aliceStatus, /alice@example.com/);
      assert.match(bobStatus, /bob@example.com/);
      const alicePublic = JSON.parse(aliceStatus) as Record<string, unknown>;
      assert.equal("accessToken" in alicePublic, false);
      assert.equal("refreshToken" in alicePublic, false);
      assert.doesNotMatch(aliceStatus, /hf-access|hf-refresh/);
      assert.doesNotMatch(bobStatus, /alice@example.com/);

      calls.length = 0;
      const menu = await toolText(handle, alice.accessToken, "get_menu", { week_offset: 0 });
      assert.match(menu, /Tacos/);
      const aliceCalls = calls.filter((call) => call.url.includes("/customers/me/subscriptions"));
      assert.ok(aliceCalls.length > 0);
      assert.ok(aliceCalls.every((call) => call.authorization === "Bearer hf-access-alice@example.com"));

      calls.length = 0;
      await toolText(handle, bob.accessToken, "get_menu", { week_offset: 0 });
      const bobCalls = calls.filter((call) => call.url.includes("/customers/me/subscriptions"));
      assert.ok(bobCalls.length > 0);
      assert.ok(bobCalls.every((call) => call.authorization === "Bearer hf-access-bob@example.com"));
    });
  });

  it("tells the HTTP login tool to reconnect the connector", async () => {
    await withServer({}, async (handle) => {
      const { accessToken } = await completePkce(handle);
      const text = await toolText(handle, accessToken, "login", {});
      assert.match(text, /Disconnect this connector/);
      assert.match(text, /apiV2Auth/);
      assert.doesNotMatch(text, /HELLOFRESH_SESSION_PATH|GOOGLE_PASSWORD|correct-hf-password/);
    });
  });

  it("advertises recipe cards and returns structured menu data", async () => {
    await withServer({}, async (handle) => {
      const { accessToken } = await completePkce(handle);
      const headers = {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${accessToken}`,
      };
      const rpc = async (method: string, params: unknown) => {
        const response = await fetch(`${handle.baseUrl}/mcp`, {
          method: "POST",
          headers,
          body: JSON.stringify({ jsonrpc: "2.0", id: 3, method, params }),
        });
        assert.equal(response.status, 200, await response.clone().text());
        return readJsonOrSse(response) as Promise<{
          result?: Record<string, unknown>;
          error?: { message: string };
        }>;
      };

      const initialized = await rpc("initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "card-test", version: "0.0.1" },
      });
      const capabilities = initialized.result?.capabilities as {
        resources?: unknown;
        extensions?: Record<string, unknown>;
      };
      assert.ok(capabilities.resources);
      assert.deepEqual(capabilities.extensions?.["io.modelcontextprotocol/ui"], {
        mimeTypes: ["text/html;profile=mcp-app"],
      });

      const listed = await rpc("tools/list", {});
      const tools = listed.result?.tools as Array<{ name: string; _meta?: Record<string, unknown> }>;
      const menuTool = tools.find((tool) => tool.name === "get_menu");
      const detailTool = tools.find((tool) => tool.name === "get_recipe_details");
      assert.deepEqual(menuTool?._meta, {
        ui: { resourceUri: "ui://hellofresh/menu" },
        "ui/resourceUri": "ui://hellofresh/menu",
      });
      assert.deepEqual(detailTool?._meta, {
        ui: { resourceUri: "ui://hellofresh/recipe" },
        "ui/resourceUri": "ui://hellofresh/recipe",
      });

      const read = await rpc("resources/read", { uri: "ui://hellofresh/menu" });
      const contents = read.result?.contents as Array<{
        mimeType?: string;
        text?: string;
        _meta?: { ui?: { csp?: { resourceDomains?: string[] } } };
      }>;
      const menuHtml = contents[0]?.text ?? "";
      assert.equal(contents[0]?.mimeType, "text/html;profile=mcp-app");
      assert.match(menuHtml, /ontoolresult/);
      assert.match(
        menuHtml,
        /https:\/\/unpkg.com\/@modelcontextprotocol\/ext-apps@1\.7\.5\/dist\/src\/app-with-deps\.js/
      );
      assert.match(menuHtml, /sendMessage/);
      assert.match(menuHtml, /isError/);
      assert.match(menuHtml, /Rechercher/);
      assert.match(menuHtml, /PAGE_SIZE = 6/);
      assert.match(menuHtml, /Précédent/);
      assert.match(menuHtml, /Valider/);
      assert.match(menuHtml, /week_label/);
      assert.deepEqual(contents[0]?._meta?.ui?.csp?.resourceDomains, [
        "https://img.hellofresh.com",
        "https://unpkg.com",
      ]);

      const recipeRead = await rpc("resources/read", { uri: "ui://hellofresh/recipe" });
      const recipeContents = recipeRead.result?.contents as Array<{ text?: string }>;
      const recipeHtml = recipeContents[0]?.text ?? "";
      assert.doesNotMatch(recipeHtml, /Ingrédients/);
      assert.doesNotMatch(recipeHtml, /Étapes/);

      const menu = await rpc("tools/call", { name: "get_menu", arguments: { week_offset: 0 } });
      const structured = menu.result?.structuredContent as {
        week_id: string;
        week_label: string;
        recipes: Array<{ name: string; imageUrl?: string; description: string }>;
      };
      assert.equal(structured.week_id, WEEK);
      assert.equal(structured.week_label, "29 décembre 2098 – 4 janvier 2099");
      assert.equal(structured.recipes[0]?.name, "Tacos");
      assert.equal(structured.recipes[0]?.description, "Crispy");
      assert.equal(
        structured.recipes[0]?.imageUrl,
        "https://img.hellofresh.com/w_800,c_limit,f_jpg,q_auto,fl_lossy/hellofresh_s3/image/tacos.jpg"
      );
      const menuText = (menu.result?.content as Array<{ text?: string }> | undefined)?.[0]?.text ?? "";
      assert.match(menuText, /Tacos/);
      assert.match(menuText, /\/image\/tacos\.jpg/);

      const details = await rpc("tools/call", {
        name: "get_recipe_details",
        arguments: { recipe_id: "recipe-1" },
      });
      const card = details.result?.structuredContent as {
        name: string;
        imageUrl?: string;
        prepTime: number | null;
        calories: number | null;
        allergens: string[];
        ingredients: string[];
        steps: string[];
      };
      assert.equal(card.name, "Tacos");
      assert.equal(card.prepTime, 25);
      assert.equal(card.calories, 640);
      assert.deepEqual(card.allergens, ["Lait"]);
      assert.deepEqual(card.ingredients, ["1 pièce Poulet"]);
      assert.deepEqual(card.steps, ["Dorer le poulet."]);
      assert.equal(
        card.imageUrl,
        "https://img.hellofresh.com/w_800,c_limit,f_jpg,q_auto,fl_lossy/hellofresh_s3/image/tacos.jpg"
      );
      const detailText = (details.result?.content as Array<{ text?: string }> | undefined)?.[0]?.text ?? "";
      assert.match(detailText, /instructionsHTML|Dorer le/);
    });
  });

  it("returns the recipe photo as image content", async () => {
    await withServer({}, async (handle, calls) => {
      const { accessToken } = await completePkce(handle);
      // An earlier get_menu warms the shared recipe cache, so this request must start cold.
      clearRecipeDetailsCache();
      calls.length = 0;
      const result = await toolCall(handle, accessToken, "get_recipe_image", { recipe_id: "recipe-1" });
      assert.equal(result.isError, undefined);
      const image = result.content?.find((item) => item.type === "image");
      assert.equal(image?.mimeType, "image/jpeg");
      assert.equal(image?.data, TINY_JPEG.toString("base64"));
      const caption = JSON.parse(result.content?.find((item) => item.type === "text")?.text ?? "{}") as {
        recipe_id: string;
        name: string;
        url: string;
        mime_type: string;
      };
      assert.equal(caption.recipe_id, "recipe-1");
      assert.equal(caption.name, "Tacos");
      assert.equal(caption.mime_type, "image/jpeg");
      assert.equal(
        caption.url,
        "https://img.hellofresh.com/w_800,c_limit,f_jpg,q_auto,fl_lossy/hellofresh_s3/image/tacos.jpg"
      );
      const cdn = calls.find((call) => call.url.startsWith("https://img.hellofresh.com/"));
      assert.ok(cdn);
      assert.equal(cdn.authorization, "");
      const recipe = calls.find((call) => call.url.includes("/recipes/recipes/"));
      assert.match(recipe?.authorization ?? "", /^Bearer hf-access-/);
    });
  });

  it("reports that rating a recipe is unsupported", async () => {
    await withServer({}, async (handle) => {
      const { accessToken } = await completePkce(handle);
      const text = await toolText(handle, accessToken, "rate_recipe", {
        recipe_id: "recipe-1",
        rating: 4,
      });
      assert.match(text, /unsupported/);
      assert.match(text, /not available/);
    });
  });
});

describe("HTTP JSON logs", () => {
  it("records authorize, token, and tool calls without secrets", async () => {
    setLogLevel("debug");
    const captured = captureLogLines();
    try {
      await withServer({}, async (handle) => {
        const tokens = await completePkce(handle, { email: "alice@example.com" });
        await toolText(handle, tokens.accessToken, "get_menu", { week_offset: 0 });
        const health = await fetch(`${handle.baseUrl}/healthz`);
        assert.equal(health.status, 200);
      });
      const blob = captured.lines.join("\n");
      const records = captured.records();
      assert.ok(records.some((row) => row.msg === "oauth.register"));
      assert.ok(records.some((row) => row.msg === "oauth.authorize" && row.outcome === "linked"));
      assert.ok(
        records.some(
          (row) => row.msg === "oauth.token" && row.grantType === "authorization_code" && row.outcome === "issued"
        )
      );
      assert.ok(records.some((row) => row.msg === "mcp.tool" && row.name === "get_menu" && row.ok === true));
      assert.ok(
        records.some(
          (row) =>
            row.msg === "hellofresh.request" &&
            typeof row.path === "string" &&
            row.path.includes("/gw/")
        )
      );
      assert.ok(records.some((row) => row.msg === "http.request" && row.path === "/healthz"));
      assert.equal(blob.includes("alice@example.com"), false);
      assert.equal(blob.includes(CORRECT_PASSWORD), false);
      assert.equal(blob.includes("mcp_"), false);
      assert.equal(blob.includes("hf-access"), false);
      assert.equal(blob.includes("Authorization"), false);
    } finally {
      captured.restore();
      setLogLevel(process.env.LOG_LEVEL);
    }
  });

  it("does not log a rejected password or email", async () => {
    setLogLevel("info");
    const captured = captureLogLines();
    try {
      await withServer({}, async (handle) => {
        const { client_id } = await registerClient(handle.baseUrl);
        const { challenge } = pkce();
        const requestId = await authorizeForm(handle, client_id, challenge);
        const denied = await fetch(`${handle.baseUrl}/authorize`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            request_id: requestId,
            auth_method: "password",
            country: "fr",
            email: "alice@example.com",
            password: "wrong-password-value",
          }),
        });
        assert.equal(denied.status, 200);
      });
      const blob = captured.lines.join("\n");
      assert.equal(blob.includes("wrong-password-value"), false);
      assert.equal(blob.includes("alice@example.com"), false);
      assert.ok(
        captured.records().some((row) => row.msg === "oauth.authorize" && row.outcome === "rejected")
      );
    } finally {
      captured.restore();
      setLogLevel(process.env.LOG_LEVEL);
    }
  });
});
