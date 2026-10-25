#!/usr/bin/env node
"use strict";
/**
 * Standalone interactive login for a local stdio install.
 * Opens Chromium (headed) on HelloFresh. Complete Continue with Google yourself.
 * Only apiV2Auth is saved. Never pass Google credentials as flags or env vars.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const accounts_js_1 = require("./accounts.js");
const login_browser_js_1 = require("./login-browser.js");
async function main() {
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
    console.error(`Opening headed Chromium on HelloFresh (${country}). Complete Continue with Google in the window.`);
    console.error("A display is required (DISPLAY on Linux). Do not type Google passwords here.");
    try {
        const stored = await (0, login_browser_js_1.captureHelloFreshAccount)({ country });
        const path = (0, accounts_js_1.resolveStdioAccountPath)();
        await (0, accounts_js_1.writeStoredAccount)(path, stored);
        console.error(`HelloFresh account saved for ${stored.email} (${stored.country}) at ${path} (${stored.savedAt})`);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(message);
        process.exitCode = 1;
    }
}
void main();
//# sourceMappingURL=login-cli.js.map