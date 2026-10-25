import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { OAuthStore, type StoredOAuthClient } from "./oauth-store.js";
import { DATA_KEY_ENV } from "./secret-box.js";

process.env[DATA_KEY_ENV] = Buffer.alloc(32, 0x11).toString("base64url");

function client(clientName: string): StoredOAuthClient {
  return {
    clientId: "abc",
    clientSecretHash: null,
    tokenEndpointAuthMethod: "none",
    redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
    clientName,
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"],
    issuedAt: 1,
  };
}

describe("OAuthStore", () => {
  it("persists clients with 0600 permissions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oauth-store-"));
    const path = join(dir, "oauth-store.json");
    const store = new OAuthStore(path);
    await store.putClient(client("oauth-client-name-should-stay-sealed"));
    const loaded = await store.getClient("abc");
    assert.equal(loaded?.clientId, "abc");
    assert.equal(loaded?.clientName, "oauth-client-name-should-stay-sealed");
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    const raw = await readFile(path, "utf8");
    assert.equal(raw.includes("oauth-client-name-should-stay-sealed"), false);
    assert.match(raw, /aes-256-gcm/);
  });

  it("reads a legacy plaintext store and seals it on the next write", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oauth-store-"));
    const path = join(dir, "oauth-store.json");
    await writeFile(
      path,
      JSON.stringify({
        clients: { abc: client("legacy-oauth-client-name") },
        tokens: {},
      })
    );
    const store = new OAuthStore(path);
    assert.equal((await store.getClient("abc"))?.clientName, "legacy-oauth-client-name");
    assert.match(await readFile(path, "utf8"), /legacy-oauth-client-name/);
    await store.putClient(client("legacy-oauth-client-name"));
    const sealed = await readFile(path, "utf8");
    assert.equal(sealed.includes("legacy-oauth-client-name"), false);
    assert.equal((await new OAuthStore(path).getClient("abc"))?.clientName, "legacy-oauth-client-name");
  });
});
