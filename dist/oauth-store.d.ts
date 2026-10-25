export declare const OAUTH_STORE_ENV_VAR = "MCP_OAUTH_STORE_PATH";
export interface StoredOAuthClient {
    clientId: string;
    clientSecretHash: string | null;
    tokenEndpointAuthMethod: string;
    redirectUris: string[];
    clientName?: string;
    grantTypes: string[];
    responseTypes: string[];
    issuedAt: number;
}
export interface StoredAccessToken {
    kind: "access";
    clientId: string;
    userId: string;
    refreshHash: string;
    expiresAt: number;
    scopes: string[];
    resource: string;
}
export interface StoredRefreshToken {
    kind: "refresh";
    clientId: string;
    userId: string;
    accessHash: string;
    expiresAt: number;
    scopes: string[];
    resource: string;
}
export type StoredToken = StoredAccessToken | StoredRefreshToken;
interface StoreFile {
    clients: Record<string, StoredOAuthClient>;
    tokens: Record<string, StoredToken>;
}
export declare class OAuthStore {
    private readonly filePath;
    private readonly mutex;
    private loaded;
    constructor(filePath: string);
    get path(): string;
    getClient(clientId: string): Promise<StoredOAuthClient | undefined>;
    putClient(client: StoredOAuthClient): Promise<void>;
    getToken(rawToken: string): Promise<StoredToken | undefined>;
    getTokenByHash(tokenHash: string): Promise<StoredToken | undefined>;
    putTokenPair(input: {
        accessToken: string;
        refreshToken: string;
        clientId: string;
        userId: string;
        accessExpiresAt: number;
        refreshExpiresAt: number;
        scopes: string[];
        resource: string;
        replaceAccessHash?: string;
        replaceRefreshHash?: string;
    }): Promise<void>;
    revokeToken(rawToken: string): Promise<void>;
    private load;
    private loadUnlocked;
    private pruneExpiredUnlocked;
    private saveUnlocked;
}
export declare function emptyOAuthStoreFile(): StoreFile;
export {};
//# sourceMappingURL=oauth-store.d.ts.map