/**
 * Session-oriented auth helpers for the HelloFresh MCP server.
 *
 * Primary path: Google SSO via "Continue with Google". Google sign-in
 * is completed by the user in an interactive browser; this process must never
 * collect, store, or automate Google credentials. Playwright storageState
 * (HelloFresh cookies) is the session artifact — wired in a later step.
 *
 * Optional fallback: HelloFresh email/password env vars for non-SSO accounts.
 */
export type AuthErrorCode = "missing_session" | "expired" | "invalid_credentials" | "challenge_sso" | "challenge_2fa" | "challenge_captcha" | "locked" | "login_failed";
export declare const MISSING_SESSION_MESSAGE = "Session expired, run login again. HelloFresh Google SSO cannot be automated; complete Continue with Google in an interactive window so the session can be reused. Do not store Google credentials. Optional fallback for password accounts: HELLOFRESH_EMAIL and HELLOFRESH_PASSWORD.";
export declare class AuthError extends Error {
    readonly code: AuthErrorCode;
    constructor(code: AuthErrorCode, message: string, options?: {
        cause?: unknown;
    });
    static missingSession(message?: string): AuthError;
    static expired(message?: string): AuthError;
    static invalidCredentials(detail?: string): AuthError;
    static loginFailed(message: string, cause?: unknown): AuthError;
}
export declare function toAuthError(error: unknown): AuthError;
export declare function formatAuthToolError(error: unknown): {
    content: Array<{
        type: "text";
        text: string;
    }>;
    isError: true;
};
/**
 * Chains async work so overlapping callers run one at a time.
 * A rejected job does not stall later jobs.
 */
export declare class AsyncMutex {
    private tail;
    runExclusive<T>(fn: () => Promise<T> | T): Promise<T>;
}
export declare function readOptionalPasswordCredentials(env?: NodeJS.ProcessEnv): {
    email: string;
    password: string;
} | undefined;
//# sourceMappingURL=auth.d.ts.map