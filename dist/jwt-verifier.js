"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createRemoteJwtVerifier = createRemoteJwtVerifier;
exports.createLocalJwtVerifier = createLocalJwtVerifier;
exports.createJwtVerifier = createJwtVerifier;
const server_1 = require("@modelcontextprotocol/server");
const jose_1 = require("jose");
function createRemoteJwtVerifier(jwksUrl, options) {
    return createJwtVerifier((0, jose_1.createRemoteJWKSet)(jwksUrl), options);
}
function createLocalJwtVerifier(jwks, options) {
    return createJwtVerifier((0, jose_1.createLocalJWKSet)(jwks), options);
}
function createJwtVerifier(getKey, options) {
    return {
        async verifyAccessToken(token) {
            let payload;
            try {
                ({ payload } = await (0, jose_1.jwtVerify)(token, getKey, {
                    issuer: options.issuer,
                    audience: options.audience,
                    algorithms: ["EdDSA", "ES256"],
                }));
            }
            catch {
                throw new server_1.OAuthError(server_1.OAuthErrorCode.InvalidToken, "Access token is invalid");
            }
            const scopes = String(payload.scope ?? "")
                .split(/[+\s]+/)
                .filter(Boolean);
            if (!scopes.includes(options.requiredScope)) {
                throw new server_1.OAuthError(server_1.OAuthErrorCode.InvalidToken, "Access token is missing required scope");
            }
            const userId = payload.userId;
            const clientId = typeof payload.client_id === "string"
                ? payload.client_id
                : typeof payload.azp === "string"
                    ? payload.azp
                    : "";
            if (!clientId) {
                throw new server_1.OAuthError(server_1.OAuthErrorCode.InvalidToken, "Access token is missing client_id");
            }
            return {
                token,
                clientId,
                scopes,
                expiresAt: payload.exp,
                resource: new URL(options.audience),
                extra: typeof userId === "string" && userId ? { userId } : {},
            };
        },
    };
}
//# sourceMappingURL=jwt-verifier.js.map