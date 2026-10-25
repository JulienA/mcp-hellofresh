#!/usr/bin/env node

import { ConfigError, loadHttpRuntimeConfig } from "./config.js";
import { startHttpServer } from "./http.js";
import { createStdioSession } from "./hellofresh-session.js";
import { log } from "./log.js";
import { isHttpMode } from "./login-mode.js";
import { HelloFreshMCPServer } from "./mcp-server.js";
import { loadDataKey, SecretBoxError } from "./secret-box.js";

function printHttpHelp(): void {
  console.error(`Usage:
  mcp-hellofresh              # stdio (default, for Claude Desktop / Claude Code)
  mcp-hellofresh --http       # Streamable HTTP + OAuth for claude.ai / ChatGPT

HTTP flags and environment:
  --http                      Enable Streamable HTTP (or MCP_HTTP=1)
  --host <host>               Bind address (HOST, default 127.0.0.1)
  --port <port>               Bind port (PORT, default 8080)
  PUBLIC_BASE_URL             Public HTTPS origin (required off localhost)
  MCP_DATA_KEY                32-byte key (base64, base64url, or hex) that encrypts data on disk
  MCP_OAUTH_STORE_PATH        Persisted OAuth clients and tokens (mode 0600, encrypted)
  MCP_USERS_DIR               Directory of per-account HelloFresh tokens
  MCP_OAUTH_REDIRECT_HOSTS    Comma-separated redirect hosts (default: claude.ai, claude.com, chatgpt.com)
  LOG_LEVEL                   debug | info | warn | error (JSON lines on stderr, default info)
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

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    printHttpHelp();
    return;
  }

  try {
    loadDataKey();
  } catch (error) {
    const message = error instanceof SecretBoxError ? error.message : String(error);
    log.error("data.key", { err: message });
    process.exitCode = 1;
    return;
  }

  if (isHttpMode(argv)) {
    let config;
    try {
      config = loadHttpRuntimeConfig(process.env, argv);
    } catch (error) {
      const message = error instanceof ConfigError ? error.message : String(error);
      log.error("http.config", { err: message });
      process.exitCode = 1;
      return;
    }
    const handle = await startHttpServer(config);
    log.info("http.listen", {
      host: config.host,
      port: handle.config.port,
      mcp: handle.config.resourceUrl.href,
    });

    const shutdown = async () => {
      await handle.close();
      process.exit(0);
    };
    process.on("SIGINT", () => void shutdown());
    process.on("SIGTERM", () => void shutdown());
    return;
  }

  const session = createStdioSession();
  const server = new HelloFreshMCPServer(session, { allowInteractiveLogin: true });
  await server.runStdio();
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  log.error("fatal", { err: message });
  process.exitCode = 1;
});
