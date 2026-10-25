"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startHttpServer = startHttpServer;
const node_http_1 = __importDefault(require("node:http"));
const server_1 = require("@modelcontextprotocol/server");
const browser_js_1 = require("./browser.js");
const mcp_server_js_1 = require("./mcp-server.js");
const node_http_js_1 = require("./node-http.js");
const oauth_js_1 = require("./oauth.js");
const oauth_store_js_1 = require("./oauth-store.js");
async function startHttpServer(config, hellofresh = new browser_js_1.HelloFreshBrowser()) {
    const server = node_http_1.default.createServer();
    await listen(server, config.host, config.port);
    const address = server.address();
    const origin = new URL(config.issuer.origin);
    if (config.port === 0) {
        origin.port = String(address.port);
    }
    const resolved = {
        ...config,
        port: address.port,
        publicBaseUrl: new URL(origin.origin),
        issuer: new URL(origin.origin),
        resourceUrl: new URL("/mcp", origin.origin),
    };
    const store = new oauth_store_js_1.OAuthStore(resolved.oauthStorePath);
    const oauth = new oauth_js_1.OwnerAuthorizationServer(resolved, store);
    const mcpHandler = (0, server_1.createMcpHandler)(() => new mcp_server_js_1.HelloFreshMCPServer(hellofresh, { allowInteractiveLogin: false }).server, { legacy: "stateless" });
    const authMetadata = {
        oauthMetadata: (0, oauth_js_1.buildAuthorizationServerMetadata)(resolved.issuer),
        resourceServerUrl: resolved.resourceUrl,
        scopesSupported: ["mcp"],
        resourceName: "HelloFresh MCP",
        dangerouslyAllowInsecureIssuerUrl: resolved.dangerouslyAllowInsecureIssuerUrl,
    };
    const resourceMetadataUrl = (0, server_1.getOAuthProtectedResourceMetadataUrl)(resolved.resourceUrl);
    const oauthGate = (0, server_1.requireBearerAuth)({
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
    const fetchHandler = async (request) => {
        const rejected = (0, server_1.hostHeaderValidationResponse)(request, allowedHosts);
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
        const metadata = (0, server_1.oauthMetadataResponse)(request, authMetadata);
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
                const request = (0, node_http_js_1.toWebRequest)(req, resolved.issuer);
                const response = await fetchHandler(request);
                await (0, node_http_js_1.sendWebResponse)(res, response);
            }
            catch (error) {
                if (!res.headersSent) {
                    res.statusCode = 500;
                    res.setHeader("Content-Type", "text/plain");
                    res.end("Internal Server Error");
                }
                else {
                    res.destroy();
                }
                const message = error instanceof Error ? error.message : String(error);
                console.error(`HTTP handler error: ${message}`);
            }
        })();
    });
    const close = async () => {
        await new Promise((resolve, reject) => {
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
async function authenticate(request, config, oauthGate) {
    if (config.bearerToken) {
        const presented = (0, oauth_js_1.parseBearerToken)(request.headers.get("authorization"));
        if (presented && (0, oauth_js_1.timingSafeEqualString)(presented, config.bearerToken)) {
            return (0, oauth_js_1.createStaticBearerAuthInfo)(presented, config.resourceUrl);
        }
    }
    return oauthGate(request);
}
function extraMetadataResponse(request, options) {
    const path = stripTrailingSlash(new URL(request.url).pathname);
    if (request.method === "OPTIONS") {
        if (path === "/.well-known/oauth-protected-resource" ||
            path === "/.well-known/openid-configuration") {
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
        const body = (0, server_1.buildOAuthProtectedResourceMetadata)(options);
        return Response.json(body, { headers: { "Access-Control-Allow-Origin": "*" } });
    }
    if (path === "/.well-known/openid-configuration") {
        return Response.json(options.oauthMetadata, {
            headers: { "Access-Control-Allow-Origin": "*" },
        });
    }
    return undefined;
}
function listen(server, host, port) {
    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
            server.off("error", reject);
            resolve();
        });
    });
}
function unique(values) {
    return [...new Set(values.filter(Boolean))];
}
function stripTrailingSlash(path) {
    if (path.length > 1 && path.endsWith("/")) {
        return path.slice(0, -1);
    }
    return path;
}
//# sourceMappingURL=http.js.map