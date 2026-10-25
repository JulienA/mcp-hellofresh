export declare const HEADLESS_LOGIN_MESSAGE = "Interactive Google SSO is not available in HTTP/headless mode. On a machine with a screen, run `npm run login`, then copy session.json onto this server and set HELLOFRESH_SESSION_PATH. Never store or automate Google credentials.";
export declare function isHttpMode(argv?: readonly string[], env?: NodeJS.ProcessEnv): boolean;
/**
 * Linux without DISPLAY/WAYLAND is treated as headless. Tests that inject a
 * headed launcher skip this check. Override with HELLOFRESH_ALLOW_HEADED=1.
 */
export declare function isHeadlessEnvironment(env?: NodeJS.ProcessEnv): boolean;
export declare function interactiveLoginBlockedReason(options?: {
    httpMode?: boolean;
    env?: NodeJS.ProcessEnv;
    hasInjectedHeadedLauncher?: boolean;
}): string | undefined;
export declare function assertInteractiveLoginAllowed(options: {
    httpMode?: boolean;
    env?: NodeJS.ProcessEnv;
    hasInjectedHeadedLauncher?: boolean;
}): void;
//# sourceMappingURL=login-mode.d.ts.map