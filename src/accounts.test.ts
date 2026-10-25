import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  accountFilePath,
  parseApiV2Auth,
  resolveUsersDir,
  userIdFor,
  writeStoredAccount,
  type StoredAccount,
} from "./accounts.js";

function account(email: string): StoredAccount {
  return {
    userId: userIdFor("fr", email),
    email,
    country: "fr",
    accessToken: "access-token",
    refreshToken: "refresh-token",
    issuedAt: 1_700_000_000,
    expiresIn: 1800,
    savedAt: "2026-10-25T09:00:00.000Z",
  };
}

describe("userIdFor", () => {
  it("is stable for a country and a normalized email", () => {
    assert.equal(userIdFor("fr", "Ada@Example.com"), userIdFor("FR", " ada@example.com "));
    assert.notEqual(userIdFor("fr", "ada@example.com"), userIdFor("uk", "ada@example.com"));
    assert.equal(userIdFor("uk", "ada@example.com").length, 64);
  });

  it("rejects an unknown country", () => {
    assert.throws(() => userIdFor("es", "ada@example.com"), /Unknown HelloFresh country/);
  });
});

describe("account files", () => {
  it("writes tokens.json mode 0600 and drops anything that is not a token field", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hf-users-"));
    const path = accountFilePath(dir, userIdFor("fr", "ada@example.com"));
    const extra = { ...account("ada@example.com"), password: "must-not-land" } as StoredAccount;
    await writeStoredAccount(path, extra);
    const raw = await readFile(path, "utf8");
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal(raw.includes("must-not-land"), false);
    assert.equal(raw.includes("password"), false);
    assert.match(raw, /access-token/);
  });

  it("refuses a user id that is not a hash", () => {
    assert.throws(() => accountFilePath("/data/users", "../etc/passwd"), /unexpected user id/);
  });

  it("places users next to the OAuth store unless MCP_USERS_DIR is set", () => {
    assert.equal(resolveUsersDir("/data/oauth-store.json", {}), "/data/users");
    assert.equal(
      resolveUsersDir("/data/oauth-store.json", { MCP_USERS_DIR: "/srv/users" }),
      "/srv/users"
    );
  });
});

describe("parseApiV2Auth", () => {
  it("reads a URL-encoded auth blob and a bare JWT", () => {
    const token = jwt({ email: "ada@example.com" });
    const encoded = encodeURIComponent(
      JSON.stringify({ access_token: token, refresh_token: "refresh-1", expires_in: 1800 })
    );
    const parsed = parseApiV2Auth(encoded);
    assert.equal(parsed?.accessToken, token);
    assert.equal(parsed?.refreshToken, "refresh-1");
    assert.equal(parsed?.expiresIn, 1800);
    assert.equal(parseApiV2Auth(token)?.accessToken, token);
    assert.equal(parseApiV2Auth("not-a-token"), undefined);
  });
});

function jwt(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${header}.${payload}.sig`;
}
