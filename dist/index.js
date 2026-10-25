#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const config_js_1 = require("./config.js");
const http_js_1 = require("./http.js");
const hellofresh_session_js_1 = require("./hellofresh-session.js");
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
  MCP_OAUTH_STORE_PATH        Persisted OAuth clients and tokens (mode 0600)
  MCP_USERS_DIR               Directory of per-account HelloFresh tokens
  MCP_OAUTH_REDIRECT_HOSTS    Comma-separated redirect hosts (default: claude.ai, claude.com, chatgpt.com)
  HELLOFRESH_COUNTRY          Country code for stdio login (default us)

Connect https://<host>/mcp in Claude or ChatGPT. Each person signs in on
/authorize with their HelloFresh password, or pastes apiV2Auth after signing
in on the HelloFresh website (Continue with Google included). There is no
shared owner secret. Do not send a Google password.

The HelloFresh API used here is unofficial and can change. A bot-protection
block is not a wrong password.

Stdio (one person): HELLOFRESH_EMAIL and HELLOFRESH_PASSWORD sign in a
password account, or run \`npm run login\` on a machine with a display.
`);
}
async function main() {
    const argv = process.argv.slice(2);
    if (argv.includes("--help") || argv.includes("-h")) {
        printHttpHelp();
        return;
    }
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
        const handle = await (0, http_js_1.startHttpServer)(config);
        console.error(`HelloFresh MCP server listening on http://${config.host}:${handle.config.port}  MCP ${handle.config.resourceUrl.href}`);
        const shutdown = async () => {
            await handle.close();
            process.exit(0);
        };
        process.on("SIGINT", () => void shutdown());
        process.on("SIGTERM", () => void shutdown());
        return;
    }
    const session = (0, hellofresh_session_js_1.createStdioSession)();
    const server = new mcp_server_js_1.HelloFreshMCPServer(session, { allowInteractiveLogin: true });
    await server.runStdio();
}
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
//# sourceMappingURL=index.js.map