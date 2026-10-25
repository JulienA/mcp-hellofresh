import { OAuthError, type AuthInfo, type OAuthMetadata, type OAuthTokenVerifier } from "@modelcontextprotocol/server";
import { type HttpRuntimeConfig } from "./config.js";
import { OAuthStore } from "./oauth-store.js";
import { timingSafeEqualString } from "./security.js";
export declare class RateLimiter {
    private readonly maxAttempts;
    private readonly windowMs;
    private readonly hits;
    constructor(maxAttempts: number, windowMs: number);
    tooMany(key: string, now?: number): boolean;
    record(key: string, now?: number): void;
}
export declare function buildAuthorizationServerMetadata(issuer: URL): OAuthMetadata;
export declare function oauthJson(body: unknown, status: number, extraHeaders?: Record<string, string>): Response;
export declare function oauthErrorResponse(error: OAuthError, status?: number): Response;
export declare class OwnerAuthorizationServer implements OAuthTokenVerifier {
    private readonly config;
    private readonly store;
    private readonly pending;
    private readonly codes;
    readonly rateLimiter: RateLimiter;
    constructor(config: HttpRuntimeConfig, store: OAuthStore);
    handle(request: Request): Promise<Response | undefined>;
    verifyAccessToken(token: string): Promise<AuthInfo>;
    private handleRegister;
    private handleAuthorize;
    private authorizeForm;
    private authorizeSubmit;
    private authorizeErrorRedirect;
    private handleToken;
    private assertClientAuth;
    private exchangeCode;
    private rotateRefresh;
    private issueTokens;
    private handleRevoke;
}
export declare function resourcesEqual(left: string, right: string): boolean;
export declare function createStaticBearerAuthInfo(token: string, resource: URL): AuthInfo;
export declare function parseBearerToken(header: string | null | undefined): string | undefined;
export { timingSafeEqualString };
//# sourceMappingURL=oauth.d.ts.map