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
} from "@modelcontextprotocol/server";
import { HelloFreshBrowser } from "./browser.js";
import type { HttpRuntimeConfig } from "./config.js";
import { HelloFreshMCPServer } from "./mcp-server.js";
import { sendWebResponse, toWebRequest } from "./node-http.js";
import {
  OwnerAuthorizationServer,
  buildAuthorizationServerMetadata,
  createStaticBearerAuthInfo,
  parseBearerToken,
  timingSafeEqualString,
} from "./oauth.js";
import { OAuthStore } from "./oauth-store.js";

export interface HttpServerHandle {
  server: http.Server;
  baseUrl: string;
  config: HttpRuntimeConfig;
  close: () => Promise<void>;
}

export async function startHttpServer(
  config: HttpRuntimeConfig,
  hellofresh: HelloFreshBrowser = new HelloFreshBrowser()
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

  const store = new OAuthStore(resolved.oauthStorePath);
  const oauth = new OwnerAuthorizationServer(resolved, store);
  const mcpHandler = createMcpHandler(
    () => new HelloFreshMCPServer(hellofresh, { allowInteractiveLogin: false }).server,
    { legacy: "stateless" }
  );

  const authMetadata: AuthMetadataOptions = {
    oauthMetadata: buildAuthorizationServerMetadata(resolved.issuer),
    resourceServerUrl: resolved.resourceUrl,
    scopesSupported: ["mcp"],
    resourceName: "HelloFresh MCP",
    dangerouslyAllowInsecureIssuerUrl: resolved.dangerouslyAllowInsecureIssuerUrl,
  };

  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resolved.resourceUrl);
  const oauthGate = requireBearerAuth({
    verifier: oauth,
    requiredScopes: ["mcp"],
    resourceMetadataUrl,
    expectedResource: resolved.resourceUrl,
  });

  const allowedHosts = unique([
    resolved.issuer.hostname,
    "localhost",
    "127.0.0.1",
  ]);

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

    const metadata = oauthMetadataResponse(request, authMetadata);
    if (metadata) {
      return metadata;
    }
    const extra = extraMetadataResponse(request, authMetadata);
    if (extra) {
      return extra;
    }

    const oauthResponse = await oauth.handle(request);
    if (oauthResponse) {
      return oauthResponse;
    }

    if (path === "/mcp") {
      const auth = await authenticate(request, resolved, oauthGate);
      if (auth instanceof Response) {
        return auth;
      }
      return mcpHandler.fetch(request, { authInfo: auth });
    }

    return new Response("Not Found", { status: 404 });
  };

  server.on("request", (req, res) => {
    void (async () => {
      try {
        const request = toWebRequest(req, resolved.issuer);
        const response = await fetchHandler(request);
        await sendWebResponse(res, response);
      } catch (error) {
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "text/plain");
          res.end("Internal Server Error");
        } else {
          res.destroy();
        }
        const message = error instanceof Error ? error.message : String(error);
        console.error(`HTTP handler error: ${message}`);
      }
    })();
  });

  const close = async (): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await mcpHandler.close();
    await hellofresh.close();
  };

  return {
    server,
    baseUrl: resolved.issuer.origin,
    config: resolved,
    close,
  };
}

async function authenticate(
  request: Request,
  config: HttpRuntimeConfig,
  oauthGate: (request: Request) => Promise<AuthInfo | Response>
): Promise<AuthInfo | Response> {
  if (config.bearerToken) {
    const presented = parseBearerToken(request.headers.get("authorization"));
    if (presented && timingSafeEqualString(presented, config.bearerToken)) {
      return createStaticBearerAuthInfo(presented, config.resourceUrl);
    }
  }
  return oauthGate(request);
}

function extraMetadataResponse(
  request: Request,
  options: AuthMetadataOptions
): Response | undefined {
  const path = stripTrailingSlash(new URL(request.url).pathname);
  if (request.method === "OPTIONS") {
    if (
      path === "/.well-known/oauth-protected-resource" ||
      path === "/.well-known/openid-configuration"
    ) {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
        },
      });
    }
    return undefined;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return undefined;
  }
  if (path === "/.well-known/oauth-protected-resource") {
    const body = buildOAuthProtectedResourceMetadata(options);
    return Response.json(body, { headers: { "Access-Control-Allow-Origin": "*" } });
  }
  if (path === "/.well-known/openid-configuration") {
    return Response.json(options.oauthMetadata, {
      headers: { "Access-Control-Allow-Origin": "*" },
    });
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
