#!/usr/bin/env node

import { HelloFreshBrowser } from "./browser.js";
import { ConfigError, loadHttpRuntimeConfig } from "./config.js";
import { startHttpServer } from "./http.js";
import { isHttpMode } from "./login-mode.js";
import { HelloFreshMCPServer } from "./mcp-server.js";

function printHttpHelp(): void {
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

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    printHttpHelp();
    return;
  }

  const hellofresh = new HelloFreshBrowser();

  if (isHttpMode(argv)) {
    let config;
    try {
      config = loadHttpRuntimeConfig(process.env, argv);
    } catch (error) {
      const message = error instanceof ConfigError ? error.message : String(error);
      console.error(message);
      process.exitCode = 1;
      return;
    }
    const handle = await startHttpServer(config, hellofresh);
    console.error(
      `HelloFresh MCP server listening on http://${config.host}:${handle.config.port}  MCP ${handle.config.resourceUrl.href}`
    );

    const shutdown = async () => {
      await handle.close();
      process.exit(0);
    };
    process.on("SIGINT", () => void shutdown());
    process.on("SIGTERM", () => void shutdown());
    return;
  }

  const server = new HelloFreshMCPServer(hellofresh, { allowInteractiveLogin: true });
  await server.runStdio();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
