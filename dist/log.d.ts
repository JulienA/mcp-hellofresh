export type LogLevelName = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;
export declare function parseLogLevel(raw: string | undefined): LogLevelName;
export declare function setLogLevel(level: string | undefined): void;
export declare function setLogSink(write: (line: string) => void): () => void;
export declare function captureLogLines(): {
    lines: string[];
    records: () => LogFields[];
    restore: () => void;
};
export declare function newRequestId(): string;
/** First 12 hex chars of the account id. Omits emails and other unexpected values. */
export declare function shortUserId(userId: string | undefined | null): string | undefined;
/** Pathname only — query strings can hold postcodes, tokens, or PKCE material. */
export declare function logPath(urlOrPath: string): string;
export declare function errorCode(error: unknown): string | undefined;
export declare function sanitizeFields(fields: LogFields | undefined): LogFields;
export declare const log: {
    debug(msg: string, fields?: LogFields): void;
    info(msg: string, fields?: LogFields): void;
    warn(msg: string, fields?: LogFields): void;
    error(msg: string, fields?: LogFields): void;
};
//# sourceMappingURL=log.d.ts.map