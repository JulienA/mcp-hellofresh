export declare const ACCOUNT_ENV_VAR = "HELLOFRESH_ACCOUNT_PATH";
export declare const USERS_DIR_ENV_VAR = "MCP_USERS_DIR";
export interface StoredAccount {
    userId: string;
    email: string;
    country: string;
    accessToken: string;
    refreshToken?: string;
    issuedAt: number;
    expiresIn: number;
    refreshExpiresIn?: number;
    refreshIssuedAt?: number;
    tokenType?: string;
    savedAt: string;
}
export interface ParsedAuthBlob {
    accessToken: string;
    refreshToken?: string;
    issuedAt?: number;
    expiresIn?: number;
    refreshExpiresIn?: number;
    refreshIssuedAt?: number;
    tokenType?: string;
}
export declare function normalizeEmail(email: string): string;
export declare function userIdFor(country: string, email: string): string;
export declare function resolveUsersDir(oauthStorePath: string, env?: NodeJS.ProcessEnv): string;
export declare function resolveStdioAccountPath(env?: NodeJS.ProcessEnv): string;
export declare function accountFilePath(usersDir: string, userId: string): string;
export declare class AccountStore {
    private readonly usersDir;
    constructor(usersDir: string);
    fileFor(userId: string): string;
    load(userId: string): Promise<StoredAccount | undefined>;
    save(account: StoredAccount): Promise<void>;
    delete(userId: string): Promise<void>;
}
export declare function readStoredAccount(path: string): Promise<StoredAccount | undefined>;
export declare function writeStoredAccount(path: string, account: StoredAccount): Promise<void>;
export declare function decodeJwtClaims(token: string): Record<string, unknown> | undefined;
export declare function emailFromClaims(claims: Record<string, unknown> | undefined): string | undefined;
/** Accept a raw or URL-encoded apiV2Auth object, or a bare access token. */
export declare function parseApiV2Auth(text: string | undefined): ParsedAuthBlob | undefined;
export declare function findEmail(value: unknown, depth?: number): string | undefined;
//# sourceMappingURL=accounts.d.ts.map