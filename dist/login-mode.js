"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HEADLESS_LOGIN_MESSAGE = void 0;
exports.isHttpMode = isHttpMode;
exports.isHeadlessEnvironment = isHeadlessEnvironment;
exports.interactiveLoginBlockedReason = interactiveLoginBlockedReason;
exports.assertInteractiveLoginAllowed = assertInteractiveLoginAllowed;
const auth_js_1 = require("./auth.js");
exports.HEADLESS_LOGIN_MESSAGE = "Interactive Google SSO is not available in HTTP/headless mode. On a machine with a screen, run `npm run login`, then copy session.json onto this server and set HELLOFRESH_SESSION_PATH. Never store or automate Google credentials.";
function isHttpMode(argv = process.argv.slice(2), env = process.env) {
    if (argv.includes("--http")) {
        return true;
    }
    const flag = env.MCP_HTTP?.trim().toLowerCase();
    return flag === "1" || flag === "true" || flag === "yes";
}
/**
 * Linux without DISPLAY/WAYLAND is treated as headless. Tests that inject a
 * headed launcher skip this check. Override with HELLOFRESH_ALLOW_HEADED=1.
 */
function isHeadlessEnvironment(env = process.env) {
    if (env.HELLOFRESH_ALLOW_HEADED === "1") {
        return false;
    }
    if (process.platform !== "linux") {
        return false;
    }
    return !env.DISPLAY && !env.WAYLAND_DISPLAY;
}
function interactiveLoginBlockedReason(options = {}) {
    if (options.httpMode) {
        return exports.HEADLESS_LOGIN_MESSAGE;
    }
    if (options.hasInjectedHeadedLauncher) {
        return undefined;
    }
    if (isHeadlessEnvironment(options.env ?? process.env)) {
        return exports.HEADLESS_LOGIN_MESSAGE;
    }
    return undefined;
}
function assertInteractiveLoginAllowed(options) {
    const reason = interactiveLoginBlockedReason(options);
    if (reason) {
        throw auth_js_1.AuthError.loginFailed(reason);
    }
}
//# sourceMappingURL=login-mode.js.map