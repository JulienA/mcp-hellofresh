import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  deletePersistedSession,
  filterHelloFreshStorageState,
  helloFreshCookiesAreValid,
  isHelloFreshLoggedInUrl,
  loadPersistedSession,
  resolveSessionPath,
  savePersistedSession,
  SESSION_ENV_VAR,
  type PlaywrightStorageState,
} from "./session.js";

function sampleState(): PlaywrightStorageState {
  return {
    cookies: [
      {
        name: "hf_session",
        value: "secret-hellofresh",
        domain: ".hellofresh.com",
        path: "/",
        expires: -1,
      },
      {
        name: "SID",
        value: "google-secret",
        domain: ".google.com",
        path: "/",
        expires: -1,
      },
    ],
    origins: [
      {
        origin: "https://www.hellofresh.com",
        localStorage: [{ name: "token", value: "hf" }],
      },
      {
        origin: "https://accounts.google.com",
        localStorage: [{ name: "oauth", value: "nope" }],
      },
    ],
  };
}

describe("resolveSessionPath", () => {
  it("prefers an explicit override, then HELLOFRESH_SESSION_PATH", () => {
    assert.equal(resolveSessionPath({}, "/tmp/override.json"), "/tmp/override.json");
    assert.equal(
      resolveSessionPath({ [SESSION_ENV_VAR]: "/tmp/from-env.json" }),
      "/tmp/from-env.json"
    );
  });

  it("uses XDG_CONFIG_HOME when set", () => {
    assert.equal(
      resolveSessionPath({ XDG_CONFIG_HOME: "/home/j/.config" }),
      join("/home/j/.config", "mcp-hellofresh", "session.json")
    );
  });
});

describe("HelloFresh URL / host helpers", () => {
  it("treats HelloFresh account URLs as logged in and login/Google as not", () => {
    assert.equal(isHelloFreshLoggedInUrl("https://www.hellofresh.com/my-account"), true);
    assert.equal(isHelloFreshLoggedInUrl("https://www.hellofresh.fr/menu"), true);
    assert.equal(isHelloFreshLoggedInUrl("https://www.hellofresh.com/login"), false);
    assert.equal(isHelloFreshLoggedInUrl("https://accounts.google.com/v3/signin"), false);
  });

  it("drops Google cookies and origins from storageState", () => {
    const filtered = filterHelloFreshStorageState(sampleState());
    assert.deepEqual(
      filtered.cookies.map((c) => c.domain),
      [".hellofresh.com"]
    );
    assert.deepEqual(
      filtered.origins.map((o) => o.origin),
      ["https://www.hellofresh.com"]
    );
    assert.equal(
      JSON.stringify(filtered).includes("google-secret"),
      false
    );
  });

  it("treats expired HelloFresh cookies as invalid", () => {
    const now = 1_700_000_000_000;
    assert.equal(helloFreshCookiesAreValid(sampleState(), now), true);
    assert.equal(
      helloFreshCookiesAreValid(
        {
          cookies: [
            {
              name: "hf_session",
              value: "x",
              domain: ".hellofresh.com",
              expires: now / 1000 - 10,
            },
          ],
          origins: [],
        },
        now
      ),
      false
    );
    assert.equal(
      helloFreshCookiesAreValid({ cookies: sampleState().cookies.filter((c) => c.domain.includes("google")), origins: [] }),
      false
    );
  });
});

describe("persisted session files", () => {
  it("writes filtered state with mode 0600 and honors the path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hf-sess-"));
    const path = join(dir, "custom-session.json");
    const saved = await savePersistedSession(path, sampleState(), new Date("2026-10-25T00:00:00.000Z"));
    const info = await stat(path);
    assert.equal(info.mode & 0o777, 0o600);
    const raw = JSON.parse(await readFile(path, "utf8")) as {
      savedAt: string;
      storageState: PlaywrightStorageState;
    };
    assert.equal(raw.savedAt, "2026-10-25T00:00:00.000Z");
    assert.equal(raw.storageState.cookies.length, 1);
    assert.equal(raw.storageState.cookies[0].name, "hf_session");
    assert.equal(JSON.stringify(raw).includes("google-secret"), false);
    assert.equal(saved.storageState.cookies[0].value, "secret-hellofresh");

    const loaded = await loadPersistedSession(path);
    assert.equal(loaded?.savedAt, "2026-10-25T00:00:00.000Z");
    assert.equal(loaded?.storageState.cookies.length, 1);

    await deletePersistedSession(path);
    assert.equal(await loadPersistedSession(path), undefined);
  });

  it("returns undefined for an empty or missing file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hf-sess-"));
    assert.equal(await loadPersistedSession(join(dir, "missing.json")), undefined);
    const emptyPath = join(dir, "empty.json");
    await writeFile(
      emptyPath,
      JSON.stringify({
        savedAt: "2026-01-01T00:00:00.000Z",
        storageState: { cookies: [], origins: [] },
      })
    );
    assert.equal(await loadPersistedSession(emptyPath), undefined);
  });
});
