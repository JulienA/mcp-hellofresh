export declare const DEFAULT_REDIRECT_HOSTS: string[];
export declare const MCP_SCOPE = "mcp";
export declare const ACCESS_TOKEN_TTL_SEC: number;
export declare const REFRESH_TOKEN_TTL_SEC: number;
export declare const AUTH_CODE_TTL_SEC: number;
export declare const DEFAULT_AUTHORIZE_MAX_ATTEMPTS = 10;
export declare const DEFAULT_AUTHORIZE_WINDOW_MS: number;
export interface HttpRuntimeConfig {
    host: string;
    port: number;
    publicBaseUrl: URL;
    issuer: URL;
    resourceUrl: URL;
    oauthStorePath: string;
    usersDir: string;
    redirectHosts: string[];
    allowLoopbackRedirects: boolean;
    authorizeMaxAttempts: number;
    authorizeWindowMs: number;
    dangerouslyAllowInsecureIssuerUrl: boolean;
}
export declare class ConfigError extends Error {
    constructor(message: string);
}
export declare function isLoopbackHostname(hostname: string): boolean;
export declare function isLocalIssuer(url: URL): boolean;
export declare function loadHttpRuntimeConfig(env?: NodeJS.ProcessEnv, argv?: readonly string[]): HttpRuntimeConfig;
export declare function redirectHostnameAllowed(redirectUri: string, hosts: readonly string[], allowLoopback: boolean): boolean;
//# sourceMappingURL=config.d.ts.map