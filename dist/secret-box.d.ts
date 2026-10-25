export declare const DATA_KEY_ENV = "MCP_DATA_KEY";
export declare const SECRET_BOX_ALG = "aes-256-gcm";
export type SecretPurpose = "account" | "session" | "oauth";
export declare class SecretBoxError extends Error {
    constructor(message: string);
}
export interface SecretText {
    text: string;
    legacy: boolean;
}
/**
 * 32-byte AES-256 key from MCP_DATA_KEY (base64, base64url, or hex).
 * A short passphrase is rejected: this value is the key, not a password.
 */
export declare function loadDataKey(env?: NodeJS.ProcessEnv): Buffer;
export declare function seal(plaintext: string, key: Buffer, purpose: SecretPurpose): string;
export declare function open(sealed: string, key: Buffer, purpose: SecretPurpose): string;
export declare function isSealed(raw: string): boolean;
/**
 * Read a sealed file. A legacy plaintext JSON file is returned only when the
 * key is configured; the next write seals it. Missing files return undefined.
 */
export declare function readSecretText(path: string, purpose: SecretPurpose, env?: NodeJS.ProcessEnv): Promise<SecretText | undefined>;
/** Atomically write ciphertext with mode 0600. Parent directories are mode 0700. */
export declare function writeSecretText(path: string, plaintext: string, purpose: SecretPurpose, env?: NodeJS.ProcessEnv): Promise<void>;
//# sourceMappingURL=secret-box.d.ts.map