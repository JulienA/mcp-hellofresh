export declare function sha256Hex(value: string | Buffer): string;
export declare function sha256Base64Url(value: string): string;
export declare function randomToken(bytes?: number): string;
/**
 * Compare two strings by SHA-256 digest so the comparison is constant-time
 * even when the inputs have different lengths.
 */
export declare function timingSafeEqualString(a: string, b: string): boolean;
export declare function timingSafeEqualHex(a: string, b: string): boolean;
export declare function parseOwnerPasswordHash(value: string): string | undefined;
export declare function htmlEscape(value: string): string;
//# sourceMappingURL=security.d.ts.map