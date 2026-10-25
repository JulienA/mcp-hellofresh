import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import {
  DATA_KEY_ENV,
  isSealed,
  loadDataKey,
  open,
  readSecretText,
  seal,
  writeSecretText,
} from "./secret-box.js";

const KEY_ENV = {
  [DATA_KEY_ENV]: Buffer.alloc(32, 0x11).toString("base64url"),
};

function otherKeyEnv(): NodeJS.ProcessEnv {
  return { [DATA_KEY_ENV]: Buffer.alloc(32, 0x22).toString("base64url") };
}

describe("loadDataKey", () => {
  it("accepts the same 32 bytes as hex, base64, or base64url", () => {
    const bytes = Buffer.alloc(32, 0x11);
    const hex = loadDataKey({ [DATA_KEY_ENV]: bytes.toString("hex") });
    const base64url = loadDataKey({ [DATA_KEY_ENV]: bytes.toString("base64url") });
    const base64 = loadDataKey({ [DATA_KEY_ENV]: bytes.toString("base64") });
    assert.deepEqual(hex, bytes);
    assert.deepEqual(base64url, bytes);
    assert.deepEqual(base64, bytes);
  });

  it("rejects a missing key and a short passphrase", () => {
    assert.throws(() => loadDataKey({}), /MCP_DATA_KEY is required/);
    assert.throws(() => loadDataKey({ [DATA_KEY_ENV]: "   " }), /MCP_DATA_KEY is required/);
    assert.throws(
      () => loadDataKey({ [DATA_KEY_ENV]: "plaintext-passphrase-rejected" }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /32 bytes/);
        assert.equal(error.message.includes("plaintext-passphrase-rejected"), false);
        return true;
      }
    );
    assert.throws(() => loadDataKey({ [DATA_KEY_ENV]: "ab".repeat(16) }), /32 bytes/);
  });
});

describe("seal and open", () => {
  it("round-trips and uses a fresh IV each time", () => {
    const key = loadDataKey(KEY_ENV);
    const first = seal("super-secret-token", key, "account");
    const second = seal("super-secret-token", key, "account");
    assert.notEqual(first, second);
    assert.equal(first.includes("super-secret-token"), false);
    const parsedFirst = JSON.parse(first) as { iv: string };
    const parsedSecond = JSON.parse(second) as { iv: string };
    assert.notEqual(parsedFirst.iv, parsedSecond.iv);
    assert.equal(open(first, key, "account"), "super-secret-token");
    assert.equal(isSealed(first), true);
  });

  it("fails on the wrong key, the wrong purpose, or a modified tag", () => {
    const key = loadDataKey(KEY_ENV);
    const sealed = seal("super-secret-token", key, "account");
    assert.throws(() => open(sealed, loadDataKey(otherKeyEnv()), "account"), /Cannot decrypt/);
    assert.throws(() => open(sealed, key, "session"), /Cannot decrypt/);
    const parsed = JSON.parse(sealed) as { tag: string };
    const tag = Buffer.from(parsed.tag, "base64url");
    tag[0] ^= 0xff;
    parsed.tag = tag.toString("base64url");
    assert.throws(() => open(JSON.stringify(parsed), key, "account"), /Cannot decrypt/);
  });
});

describe("secret files", () => {
  it("writes mode 0600 ciphertext and a 0700 directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hf-seal-"));
    const path = join(dir, "nested", "tokens.json");
    await writeSecretText(path, JSON.stringify({ accessToken: "super-secret-token" }), "account", KEY_ENV);
    const raw = await readFile(path, "utf8");
    assert.equal(raw.includes("super-secret-token"), false);
    assert.match(raw, /aes-256-gcm/);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(dirname(path))).mode & 0o777, 0o700);
    const loaded = await readSecretText(path, "account", KEY_ENV);
    assert.equal(loaded?.legacy, false);
    assert.match(loaded?.text ?? "", /super-secret-token/);
    await assert.rejects(() => readSecretText(path, "oauth", KEY_ENV), /Cannot decrypt/);
  });

  it("reads legacy plaintext only when the key is set, and seals it on the next write", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hf-legacy-"));
    const path = join(dir, "account.json");
    await writeFile(path, JSON.stringify({ accessToken: "legacy-plaintext-secret" }));
    await assert.rejects(() => readSecretText(path, "account", {}), /MCP_DATA_KEY is required/);
    assert.match(await readFile(path, "utf8"), /legacy-plaintext-secret/);
    const loaded = await readSecretText(path, "account", KEY_ENV);
    assert.equal(loaded?.legacy, true);
    assert.match(loaded?.text ?? "", /legacy-plaintext-secret/);
    assert.match(await readFile(path, "utf8"), /legacy-plaintext-secret/);
    await writeSecretText(path, loaded?.text ?? "", "account", KEY_ENV);
    const sealed = await readFile(path, "utf8");
    assert.equal(sealed.includes("legacy-plaintext-secret"), false);
    const again = await readSecretText(path, "account", KEY_ENV);
    assert.equal(again?.legacy, false);
    assert.match(again?.text ?? "", /legacy-plaintext-secret/);
  });

  it("returns undefined for a missing file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hf-missing-"));
    assert.equal(await readSecretText(join(dir, "nope.json"), "session", {}), undefined);
  });
});

describe("process startup", () => {
  const indexPath = join(__dirname, "index.js");

  it("prints help without a data key", async () => {
    const result = await runIndex(["--help"], {});
    assert.equal(result.code, 0);
    assert.match(result.stderr, /MCP_DATA_KEY/);
  });

  it("refuses to start when the key is missing or not 32 bytes", async () => {
    const missing = await runIndex([], {});
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /MCP_DATA_KEY is required/);

    const rejected = "plaintext-passphrase-rejected";
    const invalid = await runIndex([], { [DATA_KEY_ENV]: rejected });
    assert.equal(invalid.code, 1);
    assert.match(invalid.stderr, /32 bytes/);
    assert.equal(invalid.stderr.includes(rejected), false);
  });

  async function runIndex(
    args: string[],
    env: NodeJS.ProcessEnv
  ): Promise<{ code: number | null; stderr: string }> {
    const childEnv = { ...process.env, ...env };
    if (!(DATA_KEY_ENV in env)) {
      delete childEnv[DATA_KEY_ENV];
    }
    const child = spawn(process.execPath, [indexPath, ...args], {
      env: childEnv,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`index.js did not exit\n${stderr}`));
      }, 5000);
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (exitCode) => {
        clearTimeout(timer);
        resolve(exitCode);
      });
    });
    return { code, stderr };
  }
});
