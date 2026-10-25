"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SecretBoxError = exports.SECRET_BOX_ALG = exports.DATA_KEY_ENV = void 0;
exports.loadDataKey = loadDataKey;
exports.seal = seal;
exports.open = open;
exports.isSealed = isSealed;
exports.readSecretText = readSecretText;
exports.writeSecretText = writeSecretText;
const node_crypto_1 = require("node:crypto");
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
exports.DATA_KEY_ENV = "MCP_DATA_KEY";
exports.SECRET_BOX_ALG = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
class SecretBoxError extends Error {
    constructor(message) {
        super(message);
        this.name = "SecretBoxError";
    }
}
exports.SecretBoxError = SecretBoxError;
/**
 * 32-byte AES-256 key from MCP_DATA_KEY (base64, base64url, or hex).
 * A short passphrase is rejected: this value is the key, not a password.
 */
function loadDataKey(env = process.env) {
    const raw = env[exports.DATA_KEY_ENV]?.trim() ?? "";
    if (!raw) {
        throw new SecretBoxError(`MCP_DATA_KEY is required to read or write stored data. Generate one with: node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`);
    }
    const key = decodeKey(raw);
    if (!key) {
        throw new SecretBoxError("MCP_DATA_KEY must be 32 bytes encoded as base64, base64url, or hex. A short passphrase is not accepted.");
    }
    return key;
}
function seal(plaintext, key, purpose) {
    assertKey(key);
    const iv = (0, node_crypto_1.randomBytes)(IV_BYTES);
    const cipher = (0, node_crypto_1.createCipheriv)(exports.SECRET_BOX_ALG, key, iv);
    cipher.setAAD(Buffer.from(purpose, "utf8"));
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    const payload = {
        v: 1,
        alg: exports.SECRET_BOX_ALG,
        iv: iv.toString("base64url"),
        tag: tag.toString("base64url"),
        ct: ct.toString("base64url"),
    };
    return JSON.stringify(payload);
}
function open(sealed, key, purpose) {
    assertKey(key);
    const payload = parseSealed(sealed);
    if (!payload) {
        throw new SecretBoxError("Stored data is not sealed.");
    }
    const iv = decodePart(payload.iv);
    const tag = decodePart(payload.tag);
    const ct = decodePart(payload.ct);
    if (!iv || !tag || !ct || iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
        throw new SecretBoxError("Stored data is not sealed.");
    }
    try {
        const decipher = (0, node_crypto_1.createDecipheriv)(exports.SECRET_BOX_ALG, key, iv);
        decipher.setAAD(Buffer.from(purpose, "utf8"));
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
    }
    catch {
        throw new SecretBoxError("Cannot decrypt stored data. MCP_DATA_KEY is wrong, or the file was modified.");
    }
}
function isSealed(raw) {
    return parseSealed(raw) !== undefined;
}
/**
 * Read a sealed file. A legacy plaintext JSON file is returned only when the
 * key is configured; the next write seals it. Missing files return undefined.
 */
async function readSecretText(path, purpose, env = process.env) {
    let raw;
    try {
        raw = await (0, promises_1.readFile)(path, "utf8");
    }
    catch (error) {
        const code = error.code;
        if (code === "ENOENT") {
            return undefined;
        }
        throw error;
    }
    const trimmed = raw.trim();
    if (!trimmed) {
        return undefined;
    }
    if (isSealed(trimmed)) {
        return { text: open(trimmed, loadDataKey(env), purpose), legacy: false };
    }
    loadDataKey(env);
    return { text: trimmed, legacy: true };
}
/** Atomically write ciphertext with mode 0600. Parent directories are mode 0700. */
async function writeSecretText(path, plaintext, purpose, env = process.env) {
    const sealed = seal(plaintext, loadDataKey(env), purpose);
    const dir = (0, node_path_1.dirname)(path);
    await (0, promises_1.mkdir)(dir, { recursive: true, mode: 0o700 });
    await (0, promises_1.chmod)(dir, 0o700);
    const tmp = `${path}.tmp`;
    await (0, promises_1.writeFile)(tmp, sealed, { mode: 0o600 });
    await (0, promises_1.chmod)(tmp, 0o600);
    await (0, promises_1.rename)(tmp, path);
    await (0, promises_1.chmod)(path, 0o600);
}
function assertKey(key) {
    if (key.length !== KEY_BYTES) {
        throw new SecretBoxError("MCP_DATA_KEY must be 32 bytes.");
    }
}
function decodeKey(raw) {
    if (/^[0-9a-fA-F]{64}$/.test(raw)) {
        return Buffer.from(raw, "hex");
    }
    if (/^[A-Za-z0-9_-]{43}$/.test(raw)) {
        const key = Buffer.from(raw, "base64url");
        return key.length === KEY_BYTES ? key : undefined;
    }
    if (/^[A-Za-z0-9+/]{43}=$/.test(raw)) {
        const key = Buffer.from(raw, "base64");
        return key.length === KEY_BYTES ? key : undefined;
    }
    return undefined;
}
function decodePart(value) {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) {
        return undefined;
    }
    try {
        return Buffer.from(value, "base64url");
    }
    catch {
        return undefined;
    }
}
function parseSealed(raw) {
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return undefined;
    }
    if (!parsed || typeof parsed !== "object") {
        return undefined;
    }
    const record = parsed;
    if (record.v !== 1 ||
        record.alg !== exports.SECRET_BOX_ALG ||
        typeof record.iv !== "string" ||
        typeof record.tag !== "string" ||
        typeof record.ct !== "string") {
        return undefined;
    }
    return {
        v: 1,
        alg: exports.SECRET_BOX_ALG,
        iv: record.iv,
        tag: record.tag,
        ct: record.ct,
    };
}
//# sourceMappingURL=secret-box.js.map