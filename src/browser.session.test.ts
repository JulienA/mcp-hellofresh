import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Browser, BrowserContext, Page } from "playwright";
import { AuthError } from "./auth.js";
import { HelloFreshBrowser } from "./browser.js";
import {
  loadPersistedSession,
  savePersistedSession,
  type PlaywrightStorageState,
} from "./session.js";

type LaunchRecord = {
  closed: boolean;
  id: number;
  headed: boolean;
};

const HF_STATE: PlaywrightStorageState = {
  cookies: [
    {
      name: "hf_session",
      value: "super-secret-cookie",
      domain: ".hellofresh.com",
      path: "/",
      expires: -1,
    },
  ],
  origins: [{ origin: "https://www.hellofresh.com", localStorage: [] }],
};

async function tempSessionPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "hf-sess-"));
  return join(dir, "session.json");
}

function createFakeLocator(options: {
  visible?: boolean;
  errorText?: string | null;
  onClick?: () => Promise<void> | void;
} = {}) {
  const locator = {
    first() {
      return locator;
    },
    async isVisible() {
      return options.visible ?? false;
    },
    async click() {
      await options.onClick?.();
    },
    async fill() {
      return undefined;
    },
    async textContent() {
      return options.errorText ?? null;
    },
  };
  return locator;
}

function createFakeBrowser(options: {
  id: number;
  launches: LaunchRecord[];
  headed?: boolean;
  url?: string;
  loginError?: string;
  expired?: boolean;
  loginAfterTicks?: number;
}): Browser {
  const record: LaunchRecord = {
    closed: false,
    id: options.id,
    headed: options.headed ?? false,
  };
  options.launches.push(record);

  let currentUrl = "about:blank";
  let ticks = 0;
  let contextState: PlaywrightStorageState = HF_STATE;

  const page = {
    async goto(url: string) {
      if (options.expired && url.includes("my-account")) {
        currentUrl = "https://www.hellofresh.com/login";
        return null;
      }
      currentUrl = url;
      return null;
    },
    async waitForLoadState() {
      return undefined;
    },
    async waitForTimeout() {
      ticks += 1;
      if (
        options.loginAfterTicks != null &&
        ticks >= options.loginAfterTicks
      ) {
        currentUrl = "https://www.hellofresh.com/my-account";
      }
    },
    locator(selector: string) {
      if (selector.includes("error-message")) {
        return createFakeLocator({ errorText: options.loginError ?? "bad creds" });
      }
      return createFakeLocator({
        onClick: () => {
          if (selector.includes("submit") || selector.includes("Log In")) {
            currentUrl = options.loginError
              ? "https://www.hellofresh.com/login"
              : options.url ?? "https://www.hellofresh.com/menu";
          }
        },
      });
    },
    url() {
      return currentUrl;
    },
    async close() {
      return undefined;
    },
  };

  const context = {
    async newPage() {
      return page as unknown as Page;
    },
    async close() {
      return undefined;
    },
    async storageState() {
      return contextState;
    },
  };

  return {
    async newContext(ctxOptions?: { storageState?: PlaywrightStorageState }) {
      if (ctxOptions?.storageState) {
        contextState = ctxOptions.storageState;
      }
      return context as unknown as BrowserContext;
    },
    async close() {
      record.closed = true;
    },
  } as unknown as Browser;
}

function browserFor(
  sessionPath: string,
  launches: LaunchRecord[],
  fake: (id: number) => ReturnType<typeof createFakeBrowser>,
  extra: ConstructorParameters<typeof HelloFreshBrowser>[0] = {}
) {
  let launchCount = 0;
  const launch = async () => {
    launchCount += 1;
    return fake(launchCount);
  };
  return {
    hf: new HelloFreshBrowser({
      sessionPath,
      launch,
      launchHeaded: launch,
      loginTimeoutMs: extra.loginTimeoutMs,
      loginPollMs: extra.loginPollMs,
      ...extra,
    }),
    get launchCount() {
      return launchCount;
    },
  };
}

describe("HelloFreshBrowser session lifecycle", () => {
  it("does not launch a browser when no session and no password fallback", async () => {
    const sessionPath = await tempSessionPath();
    const launches: LaunchRecord[] = [];
    const ctx = browserFor(sessionPath, launches, (id) =>
      createFakeBrowser({ id, launches })
    );

    await assert.rejects(() => ctx.hf.ensureReady(), (err: unknown) => {
      assert.ok(err instanceof AuthError);
      assert.equal(err.code, "missing_session");
      assert.match(err.message, /run login again/i);
      return true;
    });
    assert.equal(ctx.launchCount, 0);
    assert.equal(ctx.hf.hasActiveBrowser(), false);
  });

  it("closes the previous browser when init() is called again", async () => {
    const sessionPath = await tempSessionPath();
    const launches: LaunchRecord[] = [];
    const { hf } = browserFor(sessionPath, launches, (id) =>
      createFakeBrowser({ id, launches })
    );

    await hf.init();
    await hf.init();
    assert.equal(launches[0].closed, true);
    assert.equal(launches[1].closed, false);
    assert.equal(hf.hasActiveBrowser(), true);
    await hf.close();
    assert.equal(launches[1].closed, true);
  });

  it("closes the browser when password login fails", async () => {
    const sessionPath = await tempSessionPath();
    const launches: LaunchRecord[] = [];
    const ctx = browserFor(sessionPath, launches, (id) =>
      createFakeBrowser({
        id,
        launches,
        url: "https://www.hellofresh.com/login",
        loginError: "Wrong password",
      })
    );

    await assert.rejects(
      () => ctx.hf.ensureReady({ email: "a@b.c", password: "nope" }),
      (err: unknown) => {
        assert.ok(err instanceof AuthError);
        assert.equal(err.code, "invalid_credentials");
        return true;
      }
    );
    assert.equal(ctx.launchCount, 1);
    assert.equal(launches[0].closed, true);
    assert.equal(ctx.hf.hasActiveBrowser(), false);
    assert.equal(ctx.hf.isSessionFlagSet(), false);
  });

  it("saves a 0600 session file after password fallback login", async () => {
    const sessionPath = await tempSessionPath();
    const launches: LaunchRecord[] = [];
    const { hf } = browserFor(sessionPath, launches, (id) =>
      createFakeBrowser({
        id,
        launches,
        url: "https://www.hellofresh.com/menu",
      })
    );

    await hf.ensureReady({ email: "a@b.c", password: "ok" });
    assert.equal(hf.hasActiveBrowser(), true);
    assert.equal(hf.isSessionFlagSet(), true);
    const info = await stat(sessionPath);
    assert.equal(info.mode & 0o777, 0o600);
    const loaded = await loadPersistedSession(sessionPath);
    assert.equal(loaded?.storageState.cookies.length, 1);
    assert.equal(loaded?.storageState.cookies[0].domain, ".hellofresh.com");
    await hf.close();
  });

  it("restores a saved session without password when the probe succeeds", async () => {
    const sessionPath = await tempSessionPath();
    await savePersistedSession(sessionPath, HF_STATE);
    const launches: LaunchRecord[] = [];
    const ctx = browserFor(sessionPath, launches, (id) =>
      createFakeBrowser({ id, launches })
    );

    await ctx.hf.ensureReady();
    assert.equal(ctx.launchCount, 1);
    assert.equal(ctx.hf.isSessionFlagSet(), true);
    await ctx.hf.close();
  });

  it("probes expiry and does not Google-relogin; password fallback may retry once", async () => {
    const sessionPath = await tempSessionPath();
    await savePersistedSession(sessionPath, HF_STATE);
    const launches: LaunchRecord[] = [];
    const { hf } = browserFor(sessionPath, launches, (id) =>
      createFakeBrowser({ id, launches, expired: true })
    );

    await assert.rejects(() => hf.ensureReady(), (err: unknown) => {
      assert.ok(err instanceof AuthError);
      assert.equal(err.code, "expired");
      assert.match(err.message, /run login again/i);
      return true;
    });
    assert.equal(hf.hasActiveBrowser(), false);
  });

  it("retries once with password fallback after an expired saved session", async () => {
    const sessionPath = await tempSessionPath();
    await savePersistedSession(sessionPath, HF_STATE);
    const launches: LaunchRecord[] = [];
    let n = 0;
    const hf = new HelloFreshBrowser({
      sessionPath,
      launch: async () => {
        n += 1;
        return createFakeBrowser({
          id: n,
          launches,
          expired: n === 1,
          url: "https://www.hellofresh.com/menu",
        });
      },
    });

    await hf.ensureReady({ email: "a@b.c", password: "ok" });
    assert.equal(n, 2);
    assert.equal(hf.isSessionFlagSet(), true);
    await hf.close();
  });

  it("serializes concurrent ensureReady calls through one login", async () => {
    const sessionPath = await tempSessionPath();
    const launches: LaunchRecord[] = [];
    let launchCount = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    const hf = new HelloFreshBrowser({
      sessionPath,
      launch: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        launchCount += 1;
        await new Promise((r) => setTimeout(r, 30));
        inFlight -= 1;
        return createFakeBrowser({
          id: launchCount,
          launches,
          url: "https://www.hellofresh.com/my-account",
        });
      },
    });

    await Promise.all([
      hf.ensureReady({ email: "a@b.c", password: "ok" }),
      hf.ensureReady({ email: "a@b.c", password: "ok" }),
      hf.ensureReady({ email: "a@b.c", password: "ok" }),
    ]);

    assert.equal(launchCount, 1);
    assert.equal(maxInFlight, 1);
    await hf.close();
  });

  it("does not leak browsers when concurrent logins fail", async () => {
    const sessionPath = await tempSessionPath();
    const launches: LaunchRecord[] = [];
    const { hf } = browserFor(sessionPath, launches, (id) =>
      createFakeBrowser({
        id,
        launches,
        url: "https://www.hellofresh.com/login",
        loginError: "nope",
      })
    );

    const results = await Promise.allSettled([
      hf.ensureReady({ email: "a@b.c", password: "nope" }),
      hf.ensureReady({ email: "a@b.c", password: "nope" }),
    ]);
    assert.equal(results.every((r) => r.status === "rejected"), true);
    assert.equal(launches.every((l) => l.closed), true);
    assert.equal(hf.hasActiveBrowser(), false);
  });
});

describe("auth_status, interactive login, logout", () => {
  it("reports a saved session without leaking cookie values", async () => {
    const sessionPath = await tempSessionPath();
    await savePersistedSession(
      sessionPath,
      HF_STATE,
      new Date("2026-10-25T12:00:00.000Z")
    );
    const launches: LaunchRecord[] = [];
    const { hf } = browserFor(sessionPath, launches, (id) =>
      createFakeBrowser({ id, launches })
    );

    const status = await hf.getAuthStatus();
    assert.equal(status.session.exists, true);
    assert.equal(status.session.valid, true);
    assert.equal(status.session.path, sessionPath);
    assert.equal(status.session.savedAt, "2026-10-25T12:00:00.000Z");
    assert.equal(status.session.helloFreshCookieCount, 1);
    assert.equal(status.passwordFallbackConfigured, false);
    const dumped = JSON.stringify(status);
    assert.equal(dumped.includes("super-secret-cookie"), false);
    assert.equal(status.browserOpen, false);
  });

  it("interactive Google SSO waits until HelloFresh is logged in, then saves and closes", async () => {
    const sessionPath = await tempSessionPath();
    const launches: LaunchRecord[] = [];
    let headedLaunches = 0;
    const hf = new HelloFreshBrowser({
      sessionPath,
      loginTimeoutMs: 500,
      loginPollMs: 5,
      launch: async () => createFakeBrowser({ id: 0, launches }),
      launchHeaded: async () => {
        headedLaunches += 1;
        return createFakeBrowser({
          id: headedLaunches,
          launches,
          headed: true,
          loginAfterTicks: 1,
        });
      },
    });

    const result = await hf.interactiveLogin();
    assert.equal(headedLaunches, 1);
    assert.equal(launches[0].headed, true);
    assert.equal(launches[0].closed, true);
    assert.equal(hf.hasActiveBrowser(), false);
    assert.equal(result.path, sessionPath);
    const loaded = await loadPersistedSession(sessionPath);
    assert.ok(loaded);
    assert.equal(loaded.storageState.cookies[0].domain, ".hellofresh.com");
    assert.equal((await stat(sessionPath)).mode & 0o777, 0o600);
  });

  it("interactive login times out if Google SSO never returns to HelloFresh", async () => {
    const sessionPath = await tempSessionPath();
    const launches: LaunchRecord[] = [];
    const hf = new HelloFreshBrowser({
      sessionPath,
      loginTimeoutMs: 20,
      loginPollMs: 5,
      launchHeaded: async () =>
        createFakeBrowser({ id: 1, launches, headed: true }),
    });

    await assert.rejects(() => hf.interactiveLogin(), (err: unknown) => {
      assert.ok(err instanceof AuthError);
      assert.equal(err.code, "login_failed");
      assert.match(err.message, /Timed out/i);
      return true;
    });
    assert.equal(launches[0].closed, true);
  });

  it("logout deletes the session file and closes the browser", async () => {
    const sessionPath = await tempSessionPath();
    const launches: LaunchRecord[] = [];
    const { hf } = browserFor(sessionPath, launches, (id) =>
      createFakeBrowser({
        id,
        launches,
        url: "https://www.hellofresh.com/menu",
      })
    );

    await hf.ensureReady({ email: "a@b.c", password: "ok" });
    assert.equal((await hf.getAuthStatus()).session.exists, true);
    await hf.logout();
    assert.equal(hf.hasActiveBrowser(), false);
    const status = await hf.getAuthStatus();
    assert.equal(status.session.exists, false);
    assert.equal(status.session.valid, false);
    assert.equal(status.authenticated, false);
  });
});
