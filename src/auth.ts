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

export type AuthErrorCode =
  | "missing_session"
  | "expired"
  | "invalid_credentials"
  | "challenge_sso"
  | "challenge_2fa"
  | "challenge_captcha"
  | "locked"
  | "login_failed";

export const MISSING_SESSION_MESSAGE =
  "Session expired, run login again. HelloFresh Google SSO cannot be automated; complete Continue with Google in an interactive window so the session can be reused. Do not store Google credentials. Optional fallback for password accounts: HELLOFRESH_EMAIL and HELLOFRESH_PASSWORD.";

export class AuthError extends Error {
  readonly code: AuthErrorCode;

  constructor(code: AuthErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "AuthError";
    this.code = code;
  }

  static missingSession(message = MISSING_SESSION_MESSAGE): AuthError {
    return new AuthError("missing_session", message);
  }

  static expired(message = MISSING_SESSION_MESSAGE): AuthError {
    return new AuthError("expired", message);
  }

  static invalidCredentials(detail?: string): AuthError {
    const suffix = detail ? `: ${detail}` : "";
    return new AuthError(
      "invalid_credentials",
      `HelloFresh email/password login failed${suffix}`
    );
  }

  static loginFailed(message: string, cause?: unknown): AuthError {
    return new AuthError("login_failed", message, cause !== undefined ? { cause } : undefined);
  }
}

export function toAuthError(error: unknown): AuthError {
  if (error instanceof AuthError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error ? error : undefined;
  return AuthError.loginFailed(message, cause);
}

export function formatAuthToolError(error: unknown): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
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
export class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  runExclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = this.tail.then(() => fn());
    this.tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }
}

export function readOptionalPasswordCredentials(
  env: NodeJS.ProcessEnv = process.env
): { email: string; password: string } | undefined {
  const email = env.HELLOFRESH_EMAIL;
  const password = env.HELLOFRESH_PASSWORD;
  if (!email || !password) {
    return undefined;
  }
  return { email, password };
}
