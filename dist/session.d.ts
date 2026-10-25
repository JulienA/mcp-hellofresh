export declare const SESSION_ENV_VAR = "HELLOFRESH_SESSION_PATH";
export declare const DEFAULT_SESSION_FILENAME = "session.json";
export interface PlaywrightCookie {
    name: string;
    value: string;
    domain: string;
    path?: string;
    expires?: number;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: "Strict" | "Lax" | "None";
}
export interface PlaywrightOrigin {
    origin: string;
    localStorage?: Array<{
        name: string;
        value: string;
    }>;
}
export interface PlaywrightStorageState {
    cookies: PlaywrightCookie[];
    origins: PlaywrightOrigin[];
}
export interface PersistedSession {
    savedAt: string;
    storageState: PlaywrightStorageState;
}
export declare function resolveSessionPath(env?: NodeJS.ProcessEnv, override?: string): string;
export declare function isHelloFreshHost(domainOrHost: string): boolean;
export declare function isHelloFreshLoggedInUrl(url: string): boolean;
export declare function toPlaywrightStorageState(state: PlaywrightStorageState): {
    cookies: Array<{
        name: string;
        value: string;
        domain: string;
        path: string;
        expires: number;
        httpOnly: boolean;
        secure: boolean;
        sameSite: "Strict" | "Lax" | "None";
    }>;
    origins: Array<{
        origin: string;
        localStorage: Array<{
            name: string;
            value: string;
        }>;
    }>;
};
export declare function filterHelloFreshStorageState(state: PlaywrightStorageState): PlaywrightStorageState;
export declare function helloFreshCookiesAreValid(state: PlaywrightStorageState, nowMs?: number): boolean;
export declare function loadPersistedSession(path: string): Promise<PersistedSession | undefined>;
export declare function savePersistedSession(path: string, storageState: PlaywrightStorageState, savedAt?: Date): Promise<PersistedSession>;
export declare function deletePersistedSession(path: string): Promise<void>;
//# sourceMappingURL=session.d.ts.map