#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const browser_js_1 = require("./browser.js");
const config_js_1 = require("./config.js");
const http_js_1 = require("./http.js");
const login_mode_js_1 = require("./login-mode.js");
const mcp_server_js_1 = require("./mcp-server.js");
function printHttpHelp() {
    console.error(`Usage:
  mcp-hellofresh              # stdio (default, for Claude Desktop / Claude Code)
  mcp-hellofresh --http       # Streamable HTTP + OAuth for claude.ai / ChatGPT

HTTP flags and environment:
  --http                      Enable Streamable HTTP (or MCP_HTTP=1)
  --host <host>               Bind address (HOST, default 127.0.0.1)
  --port <port>               Bind port (PORT, default 8080)
  PUBLIC_BASE_URL             Public HTTPS origin (required off localhost)
  MCP_OWNER_PASSWORD          Owner secret for the authorize page (required in HTTP mode)
  MCP_OWNER_PASSWORD_HASH     sha256:<hex> alternative to MCP_OWNER_PASSWORD
  MCP_BEARER_TOKEN            Optional static bearer token for other clients
  MCP_OAUTH_STORE_PATH        Persisted clients/tokens file (mode 0600)
  MCP_OAUTH_REDIRECT_HOSTS    Comma-separated redirect hosts (default: claude.ai, claude.com, chatgpt.com)
  HELLOFRESH_SESSION_PATH     Copied HelloFresh session.json from \`npm run login\`

The authorize page asks for the owner secret only. Never store Google credentials.
`);
}
async function main() {
    const argv = process.argv.slice(2);
    if (argv.includes("--help") || argv.includes("-h")) {
        printHttpHelp();
        return;
    }
    const hellofresh = new browser_js_1.HelloFreshBrowser();
    if ((0, login_mode_js_1.isHttpMode)(argv)) {
        let config;
        try {
            config = (0, config_js_1.loadHttpRuntimeConfig)(process.env, argv);
        }
        catch (error) {
            const message = error instanceof config_js_1.ConfigError ? error.message : String(error);
            console.error(message);
            process.exitCode = 1;
            return;
        }
        const handle = await (0, http_js_1.startHttpServer)(config, hellofresh);
        console.error(`HelloFresh MCP server listening on http://${config.host}:${handle.config.port}  MCP ${handle.config.resourceUrl.href}`);
        const shutdown = async () => {
            await handle.close();
            process.exit(0);
        };
        process.on("SIGINT", () => void shutdown());
        process.on("SIGTERM", () => void shutdown());
        return;
    }
    const server = new mcp_server_js_1.HelloFreshMCPServer(hellofresh, { allowInteractiveLogin: true });
    await server.runStdio();
}
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
//# sourceMappingURL=index.js.map