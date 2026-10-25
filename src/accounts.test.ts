import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import {
  accountFilePath,
  parseApiV2Auth,
  readStoredAccount,
  resolveUsersDir,
  userIdFor,
  writeStoredAccount,
  type StoredAccount,
} from "./accounts.js";
import { DATA_KEY_ENV } from "./secret-box.js";

process.env[DATA_KEY_ENV] = Buffer.alloc(32, 0x11).toString("base64url");

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
    assert.equal(raw.includes("access-token"), false);
    assert.equal(raw.includes("ada@example.com"), false);
    assert.match(raw, /aes-256-gcm/);
    const loaded = await readStoredAccount(path);
    assert.equal(loaded?.accessToken, "access-token");
    assert.equal(loaded?.refreshToken, "refresh-token");
    assert.equal(loaded?.email, "ada@example.com");
  });

  it("reads a legacy plaintext account and seals it on the next write", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hf-users-"));
    const path = accountFilePath(dir, userIdFor("fr", "ada@example.com"));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(account("ada@example.com")));
    const loaded = await readStoredAccount(path);
    assert.equal(loaded?.accessToken, "access-token");
    assert.match(await readFile(path, "utf8"), /access-token/);
    await writeStoredAccount(path, loaded ?? account("ada@example.com"));
    const sealed = await readFile(path, "utf8");
    assert.equal(sealed.includes("access-token"), false);
    assert.equal(sealed.includes("ada@example.com"), false);
    assert.equal((await readStoredAccount(path))?.refreshToken, "refresh-token");
  });

  it("does not read a legacy account when MCP_DATA_KEY is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hf-users-"));
    const path = accountFilePath(dir, userIdFor("fr", "ada@example.com"));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(account("ada@example.com")));
    const previous = process.env[DATA_KEY_ENV];
    delete process.env[DATA_KEY_ENV];
    try {
      await assert.rejects(() => readStoredAccount(path), /MCP_DATA_KEY is required/);
      assert.match(await readFile(path, "utf8"), /access-token/);
    } finally {
      process.env[DATA_KEY_ENV] = previous;
    }
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
