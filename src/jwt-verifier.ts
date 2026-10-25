import {
  OAuthError,
  OAuthErrorCode,
  type AuthInfo,
  type OAuthTokenVerifier,
} from "@modelcontextprotocol/server";
import {
  createLocalJWKSet,
  createRemoteJWKSet,
  jwtVerify,
  type JSONWebKeySet,
  type JWTVerifyGetKey,
} from "jose";

export interface JwtVerifierOptions {
  issuer: string;
  audience: string;
  requiredScope: string;
}

export function createRemoteJwtVerifier(
  jwksUrl: URL,
  options: JwtVerifierOptions
): OAuthTokenVerifier {
  return createJwtVerifier(createRemoteJWKSet(jwksUrl), options);
}

export function createLocalJwtVerifier(
  jwks: JSONWebKeySet,
  options: JwtVerifierOptions
): OAuthTokenVerifier {
  return createJwtVerifier(createLocalJWKSet(jwks), options);
}

export function createJwtVerifier(
  getKey: JWTVerifyGetKey,
  options: JwtVerifierOptions
): OAuthTokenVerifier {
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      let payload;
      try {
        ({ payload } = await jwtVerify(token, getKey, {
          issuer: options.issuer,
          audience: options.audience,
          algorithms: ["EdDSA", "ES256"],
        }));
      } catch {
        throw new OAuthError(OAuthErrorCode.InvalidToken, "Access token is invalid");
      }

      const scopes = String(payload.scope ?? "")
        .split(/[+\s]+/)
        .filter(Boolean);
      if (!scopes.includes(options.requiredScope)) {
        throw new OAuthError(OAuthErrorCode.InvalidToken, "Access token is missing required scope");
      }

      const userId = payload.userId;
      const clientId =
        typeof payload.client_id === "string"
          ? payload.client_id
          : typeof payload.azp === "string"
            ? payload.azp
            : "";
      if (!clientId) {
        throw new OAuthError(OAuthErrorCode.InvalidToken, "Access token is missing client_id");
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
