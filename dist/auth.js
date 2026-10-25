"use strict";
/**
 * Session-oriented auth helpers for the HelloFresh MCP server.
 *
 * Primary path: Google SSO via "Continue with Google". Google sign-in
 * is completed by the user in an interactive browser; this process must never
 * collect, store, or automate Google credentials. Playwright storageState
 * (HelloFresh cookies) is the session artifact. Google cookies are filtered out.
 *
 * Optional fallback: HelloFresh email/password env vars for non-SSO accounts.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.AsyncMutex = exports.AuthError = exports.LOGIN_WINDOW_MESSAGE = exports.MISSING_SESSION_MESSAGE = void 0;
exports.toAuthError = toAuthError;
exports.formatAuthToolError = formatAuthToolError;
exports.readOptionalPasswordCredentials = readOptionalPasswordCredentials;
exports.MISSING_SESSION_MESSAGE = "Session expired, run login again. Call the login tool (needs a display) or run `npm run login` and complete Continue with Google in the headed window. Do not store Google credentials. Optional fallback for password accounts: HELLOFRESH_EMAIL and HELLOFRESH_PASSWORD.";
exports.LOGIN_WINDOW_MESSAGE = "A headed Chromium window is open on the HelloFresh login page. Complete Continue with Google there. Do not type a Google password into this chat or into any MCP prompt.";
class AuthError extends Error {
    code;
    constructor(code, message, options) {
        super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
        this.name = "AuthError";
        this.code = code;
    }
    static missingSession(message = exports.MISSING_SESSION_MESSAGE) {
        return new AuthError("missing_session", message);
    }
    static expired(message = exports.MISSING_SESSION_MESSAGE) {
        return new AuthError("expired", message);
    }
    static invalidCredentials(detail) {
        const suffix = detail ? `: ${detail}` : "";
        return new AuthError("invalid_credentials", `HelloFresh email/password login failed${suffix}`);
    }
    static loginFailed(message, cause) {
        return new AuthError("login_failed", message, cause !== undefined ? { cause } : undefined);
    }
}
exports.AuthError = AuthError;
function toAuthError(error) {
    if (error instanceof AuthError) {
        return error;
    }
    const message = error instanceof Error ? error.message : String(error);
    const cause = error instanceof Error ? error : undefined;
    return AuthError.loginFailed(message, cause);
}
function formatAuthToolError(error) {
    if (error instanceof AuthError) {
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({ error: error.code, message: error.message }, null, 2),
                },
            ],
            isError: true,
        };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
        content: [{ type: "text", text: `Error: ${message}` }],
        isError: true,
    };
}
/**
 * Chains async work so overlapping callers run one at a time.
 * A rejected job does not stall later jobs.
 */
class AsyncMutex {
    tail = Promise.resolve();
    runExclusive(fn) {
        const run = this.tail.then(() => fn());
        this.tail = run.then(() => undefined, () => undefined);
        return run;
    }
}
exports.AsyncMutex = AsyncMutex;
function readOptionalPasswordCredentials(env = process.env) {
    const email = env.HELLOFRESH_EMAIL;
    const password = env.HELLOFRESH_PASSWORD;
    if (!email || !password) {
        return undefined;
    }
    return { email, password };
}
//# sourceMappingURL=auth.js.map