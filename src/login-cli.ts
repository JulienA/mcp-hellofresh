#!/usr/bin/env node

/**
 * Standalone interactive login for a local stdio install.
 * Opens Chromium (headed) on HelloFresh. Complete Continue with Google yourself.
 * Only apiV2Auth is saved. Never pass Google credentials as flags or env vars.
 */

import { resolveStdioAccountPath, writeStoredAccount } from "./accounts.js";
import { captureHelloFreshAccount } from "./login-browser.js";

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.error(`Usage: npm run login

Opens a headed Chromium window on the HelloFresh login page for
HELLOFRESH_COUNTRY (default us). Complete "Continue with Google" in that
window (display required). The HelloFresh apiV2Auth tokens are saved to
HELLOFRESH_ACCOUNT_PATH or ~/.config/mcp-hellofresh/account.json (mode 0600).

HTTP connectors (claude.ai / ChatGPT) do not use this file. Each person
signs in on the server's /authorize page with a HelloFresh password, or
pastes apiV2Auth after signing in on the HelloFresh website.

Do not pass a Google password. Optional HelloFresh password accounts can
use HELLOFRESH_EMAIL / HELLOFRESH_PASSWORD with the local MCP server.
`);
    process.exit(0);
  }

  const country = process.env.HELLOFRESH_COUNTRY?.trim() || "us";
  console.error(
    `Opening headed Chromium on HelloFresh (${country}). Complete Continue with Google in the window.`
  );
  console.error("A display is required (DISPLAY on Linux). Do not type Google passwords here.");

  try {
    const stored = await captureHelloFreshAccount({ country });
    const path = resolveStdioAccountPath();
    await writeStoredAccount(path, stored);
    console.error(
      `HelloFresh account saved for ${stored.email} (${stored.country}) at ${path} (${stored.savedAt})`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  }
}

void main();
