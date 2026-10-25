"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.toWebRequest = toWebRequest;
exports.sendWebResponse = sendWebResponse;
const node_stream_1 = require("node:stream");
const promises_1 = require("node:stream/promises");
const BODYLESS = new Set(["GET", "HEAD"]);
function toWebRequest(req, publicOrigin) {
    const method = (req.method ?? "GET").toUpperCase();
    const forwardedProto = headerValue(req.headers["x-forwarded-proto"]);
    const proto = forwardedProto?.split(",")[0]?.trim() || publicOrigin.protocol.replace(":", "");
    const host = headerValue(req.headers.host) || publicOrigin.host;
    const url = `${proto}://${host}${req.url ?? "/"}`;
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
        if (value === undefined || key === "transfer-encoding") {
            continue;
        }
        if (Array.isArray(value)) {
            for (const item of value) {
                headers.append(key, item);
            }
        }
        else {
            headers.set(key, value);
        }
    }
    const init = {
        method,
        headers,
    };
    if (!BODYLESS.has(method)) {
        init.body = node_stream_1.Readable.toWeb(req);
        init.duplex = "half";
    }
    return new Request(url, init);
}
async function sendWebResponse(res, response) {
    res.statusCode = response.status;
    const headers = new Headers(response.headers);
    headers.delete("transfer-encoding");
    headers.delete("connection");
    for (const [key, value] of headers.entries()) {
        res.setHeader(key, value);
    }
    if (!response.body) {
        res.end();
        return;
    }
    await (0, promises_1.pipeline)(node_stream_1.Readable.fromWeb(response.body), res);
}
function headerValue(value) {
    if (Array.isArray(value)) {
        return value[0];
    }
    return value;
}
//# sourceMappingURL=node-http.js.map