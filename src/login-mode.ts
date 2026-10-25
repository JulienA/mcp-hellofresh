import { AuthError } from "./auth.js";

export const HEADLESS_LOGIN_MESSAGE =
  "Interactive Google SSO is not available in HTTP/headless mode. On a machine with a screen, run `npm run login`, then copy session.json onto this server and set HELLOFRESH_SESSION_PATH. Never store or automate Google credentials.";

export function isHttpMode(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env
): boolean {
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
export function isHeadlessEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.HELLOFRESH_ALLOW_HEADED === "1") {
    return false;
  }
  if (process.platform !== "linux") {
    return false;
  }
  return !env.DISPLAY && !env.WAYLAND_DISPLAY;
}

export function interactiveLoginBlockedReason(options: {
  httpMode?: boolean;
  env?: NodeJS.ProcessEnv;
  hasInjectedHeadedLauncher?: boolean;
} = {}): string | undefined {
  if (options.httpMode) {
    return HEADLESS_LOGIN_MESSAGE;
  }
  if (options.hasInjectedHeadedLauncher) {
    return undefined;
  }
  if (isHeadlessEnvironment(options.env ?? process.env)) {
    return HEADLESS_LOGIN_MESSAGE;
  }
  return undefined;
}

export function assertInteractiveLoginAllowed(options: {
  httpMode?: boolean;
  env?: NodeJS.ProcessEnv;
  hasInjectedHeadedLauncher?: boolean;
}): void {
  const reason = interactiveLoginBlockedReason(options);
  if (reason) {
    throw AuthError.loginFailed(reason);
  }
}
