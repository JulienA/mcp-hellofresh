import { type OAuthTokenVerifier } from "@modelcontextprotocol/server";
import { type JSONWebKeySet, type JWTVerifyGetKey } from "jose";
export interface JwtVerifierOptions {
    issuer: string;
    audience: string;
    requiredScope: string;
}
export declare function createRemoteJwtVerifier(jwksUrl: URL, options: JwtVerifierOptions): OAuthTokenVerifier;
export declare function createLocalJwtVerifier(jwks: JSONWebKeySet, options: JwtVerifierOptions): OAuthTokenVerifier;
export declare function createJwtVerifier(getKey: JWTVerifyGetKey, options: JwtVerifierOptions): OAuthTokenVerifier;
//# sourceMappingURL=jwt-verifier.d.ts.map