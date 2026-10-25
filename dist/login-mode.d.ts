export declare const HTTP_LOGIN_MESSAGE = "Disconnect this connector in Claude or ChatGPT, then connect it again. Sign in on the authorize page with your HelloFresh password, or paste apiV2Auth after you sign in on the HelloFresh website (Continue with Google included). Do not send a password to this tool.";
export declare const HEADLESS_LOGIN_MESSAGE = "Interactive sign-in needs a display. Run `npm run login` and finish Continue with Google in that window. A remote HTTP connector is signed in on its authorize page instead. Do not send a Google password.";
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
export declare function assertInteractiveLoginAllowed(options?: {
    httpMode?: boolean;
    env?: NodeJS.ProcessEnv;
    hasInjectedHeadedLauncher?: boolean;
}): void;
//# sourceMappingURL=login-mode.d.ts.map