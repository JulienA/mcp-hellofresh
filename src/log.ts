import { randomBytes } from "node:crypto";
import { currentHelloFreshUserId, currentRequestId } from "./request-context.js";

export type LogLevelName = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

const LEVELS: Record<LogLevelName, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const SENSITIVE_KEY =
  /password|passwd|secret|token|authorization|cookie|email|username|verifier|api[_-]?v2[_-]?auth/i;

let minLevel = parseLogLevel(process.env.LOG_LEVEL);
let sink: (line: string) => void = writeStderr;

function writeStderr(line: string): void {
  process.stderr.write(`${line}\n`);
}

export function parseLogLevel(raw: string | undefined): LogLevelName {
  const value = raw?.trim().toLowerCase();
  if (value === "debug" || value === "info" || value === "warn" || value === "error") {
    return value;
  }
  return "info";
}

export function setLogLevel(level: string | undefined): void {
  minLevel = parseLogLevel(level);
}

export function setLogSink(write: (line: string) => void): () => void {
  const previous = sink;
  sink = write;
  return () => {
    sink = previous;
  };
}

export function captureLogLines(): {
  lines: string[];
  records: () => LogFields[];
  restore: () => void;
} {
  const lines: string[] = [];
  const restore = setLogSink((line) => {
    lines.push(line);
  });
  return {
    lines,
    records: () => lines.map((line) => JSON.parse(line) as LogFields),
    restore,
  };
}

export function newRequestId(): string {
  return randomBytes(8).toString("hex");
}

/** First 12 hex chars of the account id. Omits emails and other unexpected values. */
export function shortUserId(userId: string | undefined | null): string | undefined {
  if (!userId || userId === "pending") {
    return undefined;
  }
  if (!/^[0-9a-f]{16,}$/i.test(userId)) {
    return undefined;
  }
  return userId.slice(0, 12).toLowerCase();
}

/** Pathname only — query strings can hold postcodes, tokens, or PKCE material. */
export function logPath(urlOrPath: string): string {
  const raw = urlOrPath.trim() || "/";
  try {
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) {
      return new URL(raw).pathname || "/";
    }
  } catch {
    // Not an absolute URL.
  }
  const cut = raw.split("?")[0]?.split("#")[0] ?? "/";
  return cut || "/";
}

export function errorCode(error: unknown): string | undefined {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === "string" && code.length > 0 && code.length <= 64) {
      return code;
    }
  }
  return undefined;
}

function looksLikeSecret(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  if (/^Bearer\s+\S+/i.test(trimmed)) {
    return true;
  }
  if (/^(mcp_|mcr_)/.test(trimmed)) {
    return true;
  }
  if (trimmed.split(".").length === 3 && trimmed.length > 40) {
    return true;
  }
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    return true;
  }
  return false;
}

export function sanitizeFields(fields: LogFields | undefined): LogFields {
  if (!fields) {
    return {};
  }
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) {
      continue;
    }
    if (key === "userId" && typeof value === "string") {
      const shortened = shortUserId(value);
      if (shortened) {
        out.userId = shortened;
      }
      continue;
    }
    if (key === "path" && typeof value === "string") {
      out.path = logPath(value);
      continue;
    }
    if (SENSITIVE_KEY.test(key)) {
      out[key] = "[redacted]";
      continue;
    }
    if (key === "code" && typeof value === "string" && value.length > 24) {
      out[key] = "[redacted]";
      continue;
    }
    if (typeof value === "string" && looksLikeSecret(value)) {
      out[key] = "[redacted]";
      continue;
    }
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
      continue;
    }
    if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
      out[key] = value.filter((item) => !looksLikeSecret(item));
    }
  }
  return out;
}

function emit(level: LogLevelName, msg: string, fields?: LogFields): void {
  if (LEVELS[level] < LEVELS[minLevel]) {
    return;
  }
  const record: LogFields = {
    ts: new Date().toISOString(),
    level,
    msg,
  };
  const requestId = currentRequestId();
  if (requestId) {
    record.requestId = requestId;
  }
  const fromContext = shortUserId(currentHelloFreshUserId());
  if (fromContext) {
    record.userId = fromContext;
  }
  Object.assign(record, sanitizeFields(fields));
  sink(JSON.stringify(record));
}

export const log = {
  debug(msg: string, fields?: LogFields): void {
    emit("debug", msg, fields);
  },
  info(msg: string, fields?: LogFields): void {
    emit("info", msg, fields);
  },
  warn(msg: string, fields?: LogFields): void {
    emit("warn", msg, fields);
  },
  error(msg: string, fields?: LogFields): void {
    emit("error", msg, fields);
  },
};
