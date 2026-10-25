"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sha256Hex = sha256Hex;
exports.sha256Base64Url = sha256Base64Url;
exports.randomToken = randomToken;
exports.timingSafeEqualString = timingSafeEqualString;
exports.timingSafeEqualHex = timingSafeEqualHex;
exports.parseOwnerPasswordHash = parseOwnerPasswordHash;
exports.htmlEscape = htmlEscape;
const node_crypto_1 = require("node:crypto");
function sha256Hex(value) {
    return (0, node_crypto_1.createHash)("sha256").update(value).digest("hex");
}
function sha256Base64Url(value) {
    return (0, node_crypto_1.createHash)("sha256").update(value).digest("base64url");
}
function randomToken(bytes = 32) {
    return (0, node_crypto_1.randomBytes)(bytes).toString("base64url");
}
/**
 * Compare two strings by SHA-256 digest so the comparison is constant-time
 * even when the inputs have different lengths.
 */
function timingSafeEqualString(a, b) {
    const left = Buffer.from(sha256Hex(a), "hex");
    const right = Buffer.from(sha256Hex(b), "hex");
    return (0, node_crypto_1.timingSafeEqual)(left, right);
}
function timingSafeEqualHex(a, b) {
    if (!/^[0-9a-f]+$/i.test(a) || !/^[0-9a-f]+$/i.test(b) || a.length !== b.length) {
        return false;
    }
    try {
        return (0, node_crypto_1.timingSafeEqual)(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
    }
    catch {
        return false;
    }
}
function parseOwnerPasswordHash(value) {
    const trimmed = value.trim();
    const match = /^sha256:([0-9a-f]{64})$/i.exec(trimmed);
    return match ? match[1].toLowerCase() : undefined;
}
function htmlEscape(value) {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}
//# sourceMappingURL=security.js.map