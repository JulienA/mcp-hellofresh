import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ACCESS_TOKEN_TTL_SEC, type HttpRuntimeConfig } from "./config.js";
import { startHttpServer, type HttpServerHandle } from "./http.js";
import { sha256Hex } from "./security.js";

const OWNER_PASSWORD = "test-owner-secret";
const CLAUDE_REDIRECT = "https://claude.ai/api/mcp/auth_callback";

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

async function tempStorePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mcp-oauth-"));
  return join(dir, "oauth-store.json");
}

function localConfig(overrides: Partial<HttpRuntimeConfig> = {}): HttpRuntimeConfig {
  const issuer = new URL("http://127.0.0.1");
  return {
    host: "127.0.0.1",
    port: 0,
    publicBaseUrl: issuer,
    issuer,
    resourceUrl: new URL("/mcp", issuer),
    ownerPasswordSha256Hex: sha256Hex(OWNER_PASSWORD),
    oauthStorePath: "/tmp/unused-oauth-store.json",
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
  fn: (handle: HttpServerHandle) => Promise<void>
): Promise<void> {
  const oauthStorePath = overrides.oauthStorePath ?? (await tempStorePath());
  const handle = await startHttpServer(localConfig({ ...overrides, oauthStorePath }));
  try {
    await fn(handle);
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

async function completePkce(
  handle: HttpServerHandle,
  options: { redirectUri?: string } = {}
): Promise<{ accessToken: string; refreshToken: string; clientId: string }> {
  const redirectUri = options.redirectUri ?? CLAUDE_REDIRECT;
  const { client_id: clientId } = await registerClient(handle.baseUrl, redirectUri);
  const { verifier, challenge } = pkce();
  const resource = handle.config.resourceUrl.href;
  const authorize = new URL("/authorize", handle.baseUrl);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("code_challenge", challenge);
  authorize.searchParams.set("code_challenge_method", "S256");
  authorize.searchParams.set("state", "xyz");
  authorize.searchParams.set("resource", resource);
  authorize.searchParams.set("scope", "mcp");

  const form = await fetch(authorize);
  assert.equal(form.status, 200);
  const html = await form.text();
  assert.match(html, /Owner secret/);
  assert.doesNotMatch(html, /Google password/i);
  const requestId = /name="request_id" value="([^"]+)"/.exec(html)?.[1];
  assert.ok(requestId);

  const submitted = await fetch(`${handle.baseUrl}/authorize`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ request_id: requestId, password: OWNER_PASSWORD }),
    redirect: "manual",
  });
  assert.equal(submitted.status, 302);
  const location = submitted.headers.get("location");
  assert.ok(location);
  const redirected = new URL(location);
  assert.equal(redirected.origin + redirected.pathname, new URL(redirectUri).origin + new URL(redirectUri).pathname);
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
      redirect_uri: redirectUri,
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
  return { accessToken: body.access_token, refreshToken: body.refresh_token, clientId };
}

describe("HTTP health and OAuth metadata", () => {
  it("serves /healthz and RFC 9728 / RFC 8414 documents", async () => {
    await withServer({}, async (handle) => {
      const health = await fetch(`${handle.baseUrl}/healthz`);
      assert.equal(health.status, 200);
      assert.deepEqual(await health.json(), { ok: true });

      const prm = await fetch(
        `${handle.baseUrl}/.well-known/oauth-protected-resource/mcp`
      );
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
  it("registers a client, exchanges a PKCE code, and refreshes", async () => {
    const storePath = await tempStorePath();
    await withServer({ oauthStorePath: storePath }, async (handle) => {
      const tokens = await completePkce(handle);
      assert.match(tokens.accessToken, /^mcp_/);

      const rawStore = await readFile(storePath, "utf8");
      assert.equal(rawStore.includes(tokens.accessToken), false);
      assert.equal(rawStore.includes(tokens.refreshToken), false);
      assert.ok(rawStore.includes(sha256Hex(tokens.accessToken)));
      assert.equal((await stat(storePath)).mode & 0o777, 0o600);

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

  it("rate-limits the authorize form", async () => {
    await withServer({ authorizeMaxAttempts: 2, authorizeWindowMs: 60_000 }, async (handle) => {
      const { client_id } = await registerClient(handle.baseUrl);
      const { challenge } = pkce();
      const authorize = new URL("/authorize", handle.baseUrl);
      authorize.searchParams.set("response_type", "code");
      authorize.searchParams.set("client_id", client_id);
      authorize.searchParams.set("redirect_uri", CLAUDE_REDIRECT);
      authorize.searchParams.set("code_challenge", challenge);
      authorize.searchParams.set("code_challenge_method", "S256");
      authorize.searchParams.set("resource", handle.config.resourceUrl.href);
      const html = await (await fetch(authorize)).text();
      const requestId = /name="request_id" value="([^"]+)"/.exec(html)?.[1];
      assert.ok(requestId);
      for (let i = 0; i < 2; i += 1) {
        const denied: Response = await fetch(`${handle.baseUrl}/authorize`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ request_id: requestId, password: "wrong" }),
        });
        assert.equal(denied.status, 403);
      }
      const limited = await fetch(`${handle.baseUrl}/authorize`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ request_id: requestId, password: "wrong" }),
      });
      assert.equal(limited.status, 429);
    });
  });

  it("rejects a wrong PKCE verifier", async () => {
    await withServer({}, async (handle) => {
      const { client_id } = await registerClient(handle.baseUrl);
      const { challenge } = pkce();
      const authorize = new URL("/authorize", handle.baseUrl);
      authorize.searchParams.set("response_type", "code");
      authorize.searchParams.set("client_id", client_id);
      authorize.searchParams.set("redirect_uri", CLAUDE_REDIRECT);
      authorize.searchParams.set("code_challenge", challenge);
      authorize.searchParams.set("code_challenge_method", "S256");
      authorize.searchParams.set("resource", handle.config.resourceUrl.href);
      const html = await (await fetch(authorize)).text();
      const requestId = /name="request_id" value="([^"]+)"/.exec(html)?.[1];
      assert.ok(requestId);
      const submitted = await fetch(`${handle.baseUrl}/authorize`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ request_id: requestId, password: OWNER_PASSWORD }),
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

  it("rejects unauthenticated and bad tokens, accepts a PKCE access token", async () => {
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

  it("accepts MCP_BEARER_TOKEN with constant-time comparison", async () => {
    const bearer = "static-test-bearer-token";
    await withServer({ bearerToken: bearer }, async (handle) => {
      const ok = await fetch(`${handle.baseUrl}/mcp`, {
        method: "POST",
        headers: {
          ...mcpHeaders,
          Authorization: `Bearer ${bearer}`,
        },
        body: JSON.stringify(initializeBody),
      });
      assert.equal(ok.status, 200, await ok.clone().text());

      const bad = await fetch(`${handle.baseUrl}/mcp`, {
        method: "POST",
        headers: {
          ...mcpHeaders,
          Authorization: "Bearer wrong-token",
        },
        body: JSON.stringify(initializeBody),
      });
      assert.equal(bad.status, 401);
    });
  });

  it("fails the login tool clearly in HTTP mode", async () => {
    const bearer = "static-test-bearer-token";
    await withServer({ bearerToken: bearer }, async (handle) => {
      const response = await fetch(`${handle.baseUrl}/mcp`, {
        method: "POST",
        headers: {
          ...mcpHeaders,
          Authorization: `Bearer ${bearer}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "login", arguments: {} },
        }),
      });
      assert.equal(response.status, 200, await response.clone().text());
      const rpc = (await readJsonOrSse(response)) as {
        result?: { isError?: boolean; content?: Array<{ text: string }> };
        error?: { message: string };
      };
      const text = rpc.result?.content?.[0]?.text ?? rpc.error?.message ?? JSON.stringify(rpc);
      assert.match(text, /HTTP\/headless|HELLOFRESH_SESSION_PATH|npm run login/i);
      assert.doesNotMatch(text, /GOOGLE_PASSWORD/);
    });
  });
});
