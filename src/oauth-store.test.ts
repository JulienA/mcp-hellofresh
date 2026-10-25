import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { OAuthStore } from "./oauth-store.js";

describe("OAuthStore", () => {
  it("persists clients with 0600 permissions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oauth-store-"));
    const path = join(dir, "oauth-store.json");
    const store = new OAuthStore(path);
    await store.putClient({
      clientId: "abc",
      clientSecretHash: null,
      tokenEndpointAuthMethod: "none",
      redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
      grantTypes: ["authorization_code", "refresh_token"],
      responseTypes: ["code"],
      issuedAt: 1,
    });
    const loaded = await store.getClient("abc");
    assert.equal(loaded?.clientId, "abc");
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  });
});
