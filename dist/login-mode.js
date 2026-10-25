"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HEADLESS_LOGIN_MESSAGE = exports.HTTP_LOGIN_MESSAGE = void 0;
exports.isHttpMode = isHttpMode;
exports.isHeadlessEnvironment = isHeadlessEnvironment;
exports.interactiveLoginBlockedReason = interactiveLoginBlockedReason;
exports.assertInteractiveLoginAllowed = assertInteractiveLoginAllowed;
const auth_js_1 = require("./auth.js");
exports.HTTP_LOGIN_MESSAGE = "Disconnect this connector in Claude or ChatGPT, then connect it again. Sign in on the authorize page with your HelloFresh password, or paste apiV2Auth after you sign in on the HelloFresh website (Continue with Google included). Do not send a password to this tool.";
exports.HEADLESS_LOGIN_MESSAGE = "Interactive sign-in needs a display. Run `npm run login` and finish Continue with Google in that window. A remote HTTP connector is signed in on its authorize page instead. Do not send a Google password.";
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
        return exports.HTTP_LOGIN_MESSAGE;
    }
    if (options.hasInjectedHeadedLauncher) {
        return undefined;
    }
    if (isHeadlessEnvironment(options.env ?? process.env)) {
        return exports.HEADLESS_LOGIN_MESSAGE;
    }
    return undefined;
}
function assertInteractiveLoginAllowed(options = {}) {
    const reason = interactiveLoginBlockedReason(options);
    if (reason) {
        throw auth_js_1.AuthError.loginFailed(reason);
    }
}
//# sourceMappingURL=login-mode.js.map