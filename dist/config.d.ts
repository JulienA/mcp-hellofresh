export declare const DEFAULT_REDIRECT_HOSTS: string[];
export declare const MCP_SCOPE = "mcp";
export declare const ACCESS_TOKEN_TTL_SEC: number;
export declare const REFRESH_TOKEN_TTL_SEC: number;
export declare const AUTH_CODE_TTL_SEC: number;
export interface HttpRuntimeConfig {
    host: string;
    port: number;
    publicBaseUrl: URL;
    issuer: URL;
    resourceUrl: URL;
    authDbPath: string;
    usersDir: string;
    authSecret: string;
    redirectHosts: string[];
    allowLoopbackRedirects: boolean;
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