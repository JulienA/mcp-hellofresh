import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  buildOAuthProtectedResourceMetadata,
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  hostHeaderValidationResponse,
  oauthMetadataResponse,
  requireBearerAuth,
  type AuthInfo,
  type AuthMetadataOptions,
  type OAuthMetadata,
} from "@modelcontextprotocol/server";
import { AccountStore } from "./accounts.js";
import { createAccountLinker, type AccountLinker } from "./account-linker.js";
import { createAuthorizationServer, isAuthorizationServerPath } from "./auth-server.js";
import type { HttpRuntimeConfig } from "./config.js";
import type { FetchLike } from "./hellofresh-api.js";
import { AccountClients } from "./hellofresh-session.js";
import { createRemoteJwtVerifier } from "./jwt-verifier.js";
import { log, logPath, newRequestId } from "./log.js";
import { HelloFreshMCPServer } from "./mcp-server.js";
import { sendWebResponse, toWebRequest } from "./node-http.js";
import {
  currentHelloFreshUserId,
  helloFreshUserContext,
  requestLogContext,
} from "./request-context.js";

export interface HttpServerHandle {
  server: http.Server;
  baseUrl: string;
  config: HttpRuntimeConfig;
  close: () => Promise<void>;
}

export interface HttpServerOptions {
  /** Injected in tests. Production uses the platform fetch. */
  fetchImpl?: FetchLike;
  /** Injected in tests. Production links accounts through /gw. */
  linker?: AccountLinker;
  /** Test-only override for JWT access-token lifetime. */
  accessTokenExpiresIn?: number;
}

export async function startHttpServer(
  config: HttpRuntimeConfig,
  options: HttpServerOptions = {}
): Promise<HttpServerHandle> {
  const server = http.createServer();
  await listen(server, config.host, config.port);
  const address = server.address() as AddressInfo;
  const origin = new URL(config.issuer.origin);
  if (config.port === 0) {
    origin.port = String(address.port);
  }

  const resolved: HttpRuntimeConfig = {
    ...config,
    port: address.port,
    publicBaseUrl: new URL(origin.origin),
    issuer: new URL(origin.origin),
    resourceUrl: new URL("/mcp", origin.origin),
  };

  const fetchImpl = options.fetchImpl ?? fetch;
  const accounts = new AccountStore(resolved.usersDir);
  const linker = options.linker ?? createAccountLinker(accounts, fetchImpl);
  const clients = new AccountClients(accounts, fetchImpl);
  const authorization = await createAuthorizationServer(resolved, linker, {
    accessTokenExpiresIn: options.accessTokenExpiresIn,
  });
  const mcpHandler = createMcpHandler(
    (ctx) => {
      const userId = userIdFromAuth(ctx.authInfo) ?? currentHelloFreshUserId();
      if (!userId) {
        throw new Error("This access token is not linked to a HelloFresh account.");
      }
      return new HelloFreshMCPServer(clients.sessionFor(userId), {
        allowInteractiveLogin: false,
      }).server;
    },
    { legacy: "stateless" }
  );

  const oauthMetadata = authorizationServerMetadata(resolved.issuer.origin);
  const authMetadata: AuthMetadataOptions = {
    oauthMetadata,
    resourceServerUrl: resolved.resourceUrl,
    scopesSupported: ["mcp"],
    resourceName: "HelloFresh MCP",
    dangerouslyAllowInsecureIssuerUrl: resolved.dangerouslyAllowInsecureIssuerUrl,
  };

  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resolved.resourceUrl);
  const oauthGate = requireBearerAuth({
    verifier: createRemoteJwtVerifier(authorization.jwksUrl, {
      issuer: authorization.issuer,
      audience: resolved.resourceUrl.href,
      requiredScope: "mcp",
    }),
    requiredScopes: ["mcp"],
    resourceMetadataUrl,
    expectedResource: resolved.resourceUrl,
  });

  const allowedHosts = unique([resolved.issuer.hostname, "localhost", "127.0.0.1"]);

  const fetchHandler = async (request: Request): Promise<Response> => {
    const rejected = hostHeaderValidationResponse(request, allowedHosts);
    if (rejected) {
      return rejected;
    }

    const url = new URL(request.url);
    const path = stripTrailingSlash(url.pathname);

    if (path === "/healthz") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method Not Allowed", {
          status: 405,
          headers: { Allow: "GET, HEAD" },
        });
      }
      const body = JSON.stringify({ ok: true });
      return new Response(request.method === "HEAD" ? null : body, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Authorization-server routes (RFC 8414, DCR, JWKS, login) come from Better Auth.
    // RFC 9728 resource metadata and the bearer gate stay on the MCP SDK.
    if (isAuthorizationServerPath(url.pathname)) {
      return authorization.handler(request);
    }

    const metadata = oauthMetadataResponse(request, authMetadata);
    if (metadata) {
      return metadata;
    }
    const extra = extraProtectedResourceMetadata(request, authMetadata);
    if (extra) {
      return extra;
    }

    if (path === "/mcp") {
      const auth = await oauthGate(request);
      if (auth instanceof Response) {
        return auth;
      }
      const userId = userIdFromAuth(auth);
      if (!userId) {
        return new Response("Unauthorized", {
          status: 401,
          headers: { "WWW-Authenticate": "Bearer" },
        });
      }
      return helloFreshUserContext.run(userId, () => mcpHandler.fetch(request, { authInfo: auth }));
    }

    return new Response("Not Found", { status: 404 });
  };

  server.on("request", (req, res) => {
    void (async () => {
      const requestId = newRequestId();
      const started = Date.now();
      const method = req.method ?? "GET";
      const path = logPath(req.url ?? "/");
      await requestLogContext.run({ requestId }, async () => {
        try {
          const request = toWebRequest(req, resolved.issuer);
          const response = await fetchHandler(request);
          await sendWebResponse(res, response);
          logHttpRequest(method, path, response.status, Date.now() - started);
        } catch (error) {
          if (!res.headersSent) {
            res.statusCode = 500;
            res.setHeader("Content-Type", "text/plain");
            res.end("Internal Server Error");
          } else {
            res.destroy();
          }
          const message = error instanceof Error ? error.message : String(error);
          log.error("http.error", {
            method,
            path,
            status: 500,
            durationMs: Date.now() - started,
            err: message,
          });
        }
      });
    })();
  });

  const close = async (): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    authorization.close();
    await mcpHandler.close();
  };

  return {
    server,
    baseUrl: resolved.issuer.origin,
    config: resolved,
    close,
  };
}

function authorizationServerMetadata(issuer: string): OAuthMetadata {
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth2/authorize`,
    token_endpoint: `${issuer}/oauth2/token`,
    registration_endpoint: `${issuer}/oauth2/register`,
    revocation_endpoint: `${issuer}/oauth2/revoke`,
    jwks_uri: `${issuer}/jwks`,
    scopes_supported: ["mcp"],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    code_challenge_methods_supported: ["S256"],
    authorization_response_iss_parameter_supported: true,
  };
}

function logHttpRequest(method: string, path: string, status: number, durationMs: number): void {
  const fields = { method, path, status, durationMs };
  if (path === "/healthz") {
    log.debug("http.request", fields);
    return;
  }
  if (status >= 500) {
    log.error("http.request", fields);
    return;
  }
  if (status >= 400) {
    log.warn("http.request", fields);
    return;
  }
  log.info("http.request", fields);
}

function userIdFromAuth(auth: AuthInfo | undefined): string | undefined {
  const userId = auth?.extra?.userId;
  return typeof userId === "string" && userId ? userId : undefined;
}

function extraProtectedResourceMetadata(
  request: Request,
  options: AuthMetadataOptions
): Response | undefined {
  const path = stripTrailingSlash(new URL(request.url).pathname);
  if (request.method === "OPTIONS" && path === "/.well-known/oauth-protected-resource") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      },
    });
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return undefined;
  }
  if (path === "/.well-known/oauth-protected-resource") {
    const body = buildOAuthProtectedResourceMetadata(options);
    return Response.json(body, { headers: { "Access-Control-Allow-Origin": "*" } });
  }
  return undefined;
}

function listen(server: http.Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function stripTrailingSlash(path: string): string {
  if (path.length > 1 && path.endsWith("/")) {
    return path.slice(0, -1);
  }
  return path;
}
