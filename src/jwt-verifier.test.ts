import assert from "node:assert/strict";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { describe, it } from "node:test";
import { OAuthError, OAuthErrorCode } from "@modelcontextprotocol/server";
import { createLocalJwtVerifier } from "./jwt-verifier.js";

const issuer = "http://127.0.0.1:8080";
const audience = "http://127.0.0.1:8080/mcp";

async function signer() {
  const { publicKey, privateKey } = await generateKeyPair("EdDSA", { crv: "Ed25519" });
  const jwk = await exportJWK(publicKey);
  jwk.alg = "EdDSA";
  jwk.kid = "test-key";
  jwk.use = "sig";
  const verifier = createLocalJwtVerifier({ keys: [jwk] }, { issuer, audience, requiredScope: "mcp" });
  return { privateKey, verifier };
}

async function mint(
  privateKey: CryptoKey,
  claims: Record<string, unknown>,
  exp: number = Math.floor(Date.now() / 1000) + 3600
): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "EdDSA", kid: "test-key", typ: "at+jwt" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(exp)
    .setSubject("user-1")
    .sign(privateKey);
}

describe("JWT access-token verifier", () => {
  it("accepts a resource-bound token and maps userId", async () => {
    const { privateKey, verifier } = await signer();
    const token = await mint(privateKey, {
      client_id: "client-1",
      scope: "mcp offline_access",
      userId: "abc123",
    });
    const auth = await verifier.verifyAccessToken(token);
    assert.equal(auth.clientId, "client-1");
    assert.deepEqual(auth.scopes, ["mcp", "offline_access"]);
    assert.equal(auth.extra?.userId, "abc123");
    assert.equal(auth.resource?.href, audience);
  });

  it("rejects a bad signature", async () => {
    const { verifier } = await signer();
    const other = await generateKeyPair("EdDSA", { crv: "Ed25519" });
    const token = await mint(other.privateKey, {
      client_id: "client-1",
      scope: "mcp",
      userId: "abc123",
    });
    await assert.rejects(
      () => verifier.verifyAccessToken(token),
      (error: unknown) => {
        assert.ok(error instanceof OAuthError);
        assert.equal(error.code, OAuthErrorCode.InvalidToken);
        return true;
      }
    );
  });

  it("rejects the wrong audience", async () => {
    const { privateKey, verifier } = await signer();
    const token = await new SignJWT({
      client_id: "client-1",
      scope: "mcp",
      userId: "abc123",
    })
      .setProtectedHeader({ alg: "EdDSA", kid: "test-key", typ: "at+jwt" })
      .setIssuer(issuer)
      .setAudience("https://evil.example/mcp")
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
      .setSubject("user-1")
      .sign(privateKey);
    await assert.rejects(
      () => verifier.verifyAccessToken(token),
      (error: unknown) => error instanceof OAuthError && error.code === OAuthErrorCode.InvalidToken
    );
  });

  it("rejects an expired token", async () => {
    const { privateKey, verifier } = await signer();
    const token = await mint(
      privateKey,
      { client_id: "client-1", scope: "mcp", userId: "abc123" },
      Math.floor(Date.now() / 1000) - 30
    );
    await assert.rejects(
      () => verifier.verifyAccessToken(token),
      (error: unknown) => error instanceof OAuthError && error.code === OAuthErrorCode.InvalidToken
    );
  });
});
