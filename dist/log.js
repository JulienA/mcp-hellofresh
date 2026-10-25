"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.log = void 0;
exports.parseLogLevel = parseLogLevel;
exports.setLogLevel = setLogLevel;
exports.setLogSink = setLogSink;
exports.captureLogLines = captureLogLines;
exports.newRequestId = newRequestId;
exports.shortUserId = shortUserId;
exports.logPath = logPath;
exports.errorCode = errorCode;
exports.sanitizeFields = sanitizeFields;
const node_crypto_1 = require("node:crypto");
const request_context_js_1 = require("./request-context.js");
const LEVELS = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
};
const SENSITIVE_KEY = /password|passwd|secret|token|authorization|cookie|email|username|verifier|api[_-]?v2[_-]?auth/i;
let minLevel = parseLogLevel(process.env.LOG_LEVEL);
let sink = writeStderr;
function writeStderr(line) {
    process.stderr.write(`${line}\n`);
}
function parseLogLevel(raw) {
    const value = raw?.trim().toLowerCase();
    if (value === "debug" || value === "info" || value === "warn" || value === "error") {
        return value;
    }
    return "info";
}
function setLogLevel(level) {
    minLevel = parseLogLevel(level);
}
function setLogSink(write) {
    const previous = sink;
    sink = write;
    return () => {
        sink = previous;
    };
}
function captureLogLines() {
    const lines = [];
    const restore = setLogSink((line) => {
        lines.push(line);
    });
    return {
        lines,
        records: () => lines.map((line) => JSON.parse(line)),
        restore,
    };
}
function newRequestId() {
    return (0, node_crypto_1.randomBytes)(8).toString("hex");
}
/** First 12 hex chars of the account id. Omits emails and other unexpected values. */
function shortUserId(userId) {
    if (!userId || userId === "pending") {
        return undefined;
    }
    if (!/^[0-9a-f]{16,}$/i.test(userId)) {
        return undefined;
    }
    return userId.slice(0, 12).toLowerCase();
}
/** Pathname only — query strings can hold postcodes, tokens, or PKCE material. */
function logPath(urlOrPath) {
    const raw = urlOrPath.trim() || "/";
    try {
        if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) {
            return new URL(raw).pathname || "/";
        }
    }
    catch {
        // Not an absolute URL.
    }
    const cut = raw.split("?")[0]?.split("#")[0] ?? "/";
    return cut || "/";
}
function errorCode(error) {
    if (error && typeof error === "object" && "code" in error) {
        const code = error.code;
        if (typeof code === "string" && code.length > 0 && code.length <= 64) {
            return code;
        }
    }
    return undefined;
}
function looksLikeSecret(value) {
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
function sanitizeFields(fields) {
    if (!fields) {
        return {};
    }
    const out = {};
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
function emit(level, msg, fields) {
    if (LEVELS[level] < LEVELS[minLevel]) {
        return;
    }
    const record = {
        ts: new Date().toISOString(),
        level,
        msg,
    };
    const requestId = (0, request_context_js_1.currentRequestId)();
    if (requestId) {
        record.requestId = requestId;
    }
    const fromContext = shortUserId((0, request_context_js_1.currentHelloFreshUserId)());
    if (fromContext) {
        record.userId = fromContext;
    }
    Object.assign(record, sanitizeFields(fields));
    sink(JSON.stringify(record));
}
exports.log = {
    debug(msg, fields) {
        emit("debug", msg, fields);
    },
    info(msg, fields) {
        emit("info", msg, fields);
    },
    warn(msg, fields) {
        emit("warn", msg, fields);
    },
    error(msg, fields) {
        emit("error", msg, fields);
    },
};
//# sourceMappingURL=log.js.map