#!/usr/bin/env node
"use strict";
/**
 * Standalone interactive login for when the MCP client cannot show a headed browser.
 * Opens Chromium (headed) on HelloFresh. Complete Continue with Google yourself.
 * Never pass Google credentials as flags or env vars.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const browser_js_1 = require("./browser.js");
async function main() {
    if (process.argv.includes("--help") || process.argv.includes("-h")) {
        console.error(`Usage: npm run login

Opens a headed Chromium window on the HelloFresh login page.
Complete "Continue with Google" in that window (display required).
The HelloFresh session is saved to HELLOFRESH_SESSION_PATH or
~/.config/mcp-hellofresh/session.json (mode 0600).

To use a remote HTTP MCP server (claude.ai / ChatGPT connectors), copy
that session.json onto the server and set HELLOFRESH_SESSION_PATH there.
The HTTP login tool will not open a browser.

Do not pass a Google password. Optional HelloFresh password accounts
can still use HELLOFRESH_EMAIL / HELLOFRESH_PASSWORD with the MCP server.
`);
        process.exit(0);
    }
    console.error("Opening headed Chromium on HelloFresh. Complete Continue with Google in the window.");
    console.error("A display is required (DISPLAY on Linux). Do not type Google passwords here.");
    const hellofresh = new browser_js_1.HelloFreshBrowser();
    try {
        const result = await hellofresh.interactiveLogin();
        console.error(`Session saved to ${result.path} (${result.savedAt})`);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(message);
        process.exitCode = 1;
    }
}
void main();
//# sourceMappingURL=login-cli.js.map