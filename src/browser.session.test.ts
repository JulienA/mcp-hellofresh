import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Browser, BrowserContext, Page } from "playwright";
import { AuthError } from "./auth.js";
import { HelloFreshBrowser } from "./browser.js";

type LaunchRecord = {
  closed: boolean;
  id: number;
};

function createFakeLocator(options: { visible?: boolean; errorText?: string | null } = {}) {
  const locator = {
    first() {
      return locator;
    },
    async isVisible() {
      return options.visible ?? false;
    },
    async click() {
      return undefined;
    },
    async fill() {
      return undefined;
    },
    async textContent() {
      return options.errorText ?? null;
    },
    async catch() {
      return "Unknown error";
    },
  };
  return locator;
}

function createFakeBrowser(options: {
  id: number;
  launches: LaunchRecord[];
  url?: string;
  loginError?: string;
}): Browser {
  const record: LaunchRecord = { closed: false, id: options.id };
  options.launches.push(record);

  const page = {
    async goto() {
      return null;
    },
    async waitForLoadState() {
      return undefined;
    },
    locator(selector: string) {
      if (selector.includes("error-message")) {
        const loc = createFakeLocator({ errorText: options.loginError ?? "bad creds" });
        return Object.assign(loc, {
          textContent: () => Promise.resolve(options.loginError ?? "bad creds"),
          catch: () => Promise.resolve(options.loginError ?? "bad creds"),
        });
      }
      return createFakeLocator();
    },
    url() {
      return options.url ?? "https://www.hellofresh.com/login";
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
  };

  return {
    async newContext() {
      return context as unknown as BrowserContext;
    },
    async close() {
      record.closed = true;
    },
  } as unknown as Browser;
}

describe("HelloFreshBrowser session lifecycle", () => {
  it("does not launch a browser when no password fallback is provided", async () => {
    const launches: LaunchRecord[] = [];
    let launchCount = 0;
    const hf = new HelloFreshBrowser({
      launch: async () => {
        launchCount += 1;
        return createFakeBrowser({ id: launchCount, launches });
      },
    });

    await assert.rejects(() => hf.ensureReady(), (err: unknown) => {
      assert.ok(err instanceof AuthError);
      assert.equal(err.code, "missing_session");
      assert.match(err.message, /run login again/i);
      return true;
    });
    assert.equal(launchCount, 0);
    assert.equal(hf.hasActiveBrowser(), false);
  });

  it("closes the previous browser when init() is called again", async () => {
    const launches: LaunchRecord[] = [];
    let launchCount = 0;
    const hf = new HelloFreshBrowser({
      launch: async () => {
        launchCount += 1;
        return createFakeBrowser({ id: launchCount, launches });
      },
    });

    await hf.init();
    await hf.init();
    assert.equal(launchCount, 2);
    assert.equal(launches[0].closed, true);
    assert.equal(launches[1].closed, false);
    assert.equal(hf.hasActiveBrowser(), true);
    await hf.close();
    assert.equal(launches[1].closed, true);
    assert.equal(hf.hasActiveBrowser(), false);
  });

  it("closes the browser when password login fails", async () => {
    const launches: LaunchRecord[] = [];
    let launchCount = 0;
    const hf = new HelloFreshBrowser({
      launch: async () => {
        launchCount += 1;
        return createFakeBrowser({
          id: launchCount,
          launches,
          url: "https://www.hellofresh.com/login",
          loginError: "Wrong password",
        });
      },
    });

    await assert.rejects(
      () => hf.ensureReady({ email: "a@b.c", password: "nope" }),
      (err: unknown) => {
        assert.ok(err instanceof AuthError);
        assert.equal(err.code, "invalid_credentials");
        return true;
      }
    );
    assert.equal(launchCount, 1);
    assert.equal(launches[0].closed, true);
    assert.equal(hf.hasActiveBrowser(), false);
    assert.equal(hf.isSessionFlagSet(), false);
  });

  it("keeps the browser open after a successful password fallback login", async () => {
    const launches: LaunchRecord[] = [];
    let launchCount = 0;
    const hf = new HelloFreshBrowser({
      launch: async () => {
        launchCount += 1;
        return createFakeBrowser({
          id: launchCount,
          launches,
          url: "https://www.hellofresh.com/menu",
        });
      },
    });

    await hf.ensureReady({ email: "a@b.c", password: "ok" });
    assert.equal(hf.hasActiveBrowser(), true);
    assert.equal(hf.isSessionFlagSet(), true);
    assert.equal(launches[0].closed, false);
    await hf.close();
  });

  it("serializes concurrent ensureReady calls through one login", async () => {
    const launches: LaunchRecord[] = [];
    let launchCount = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    const hf = new HelloFreshBrowser({
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
    assert.equal(hf.isSessionFlagSet(), true);
    await hf.close();
  });

  it("does not leak browsers when concurrent logins fail then retry", async () => {
    const launches: LaunchRecord[] = [];
    let launchCount = 0;
    const hf = new HelloFreshBrowser({
      launch: async () => {
        launchCount += 1;
        return createFakeBrowser({
          id: launchCount,
          launches,
          url: "https://www.hellofresh.com/login",
        });
      },
    });

    const attempts = Promise.allSettled([
      hf.ensureReady({ email: "a@b.c", password: "nope" }),
      hf.ensureReady({ email: "a@b.c", password: "nope" }),
    ]);
    const results = await attempts;
    assert.equal(results.every((r) => r.status === "rejected"), true);
    assert.equal(
      launches.every((l) => l.closed),
      true,
      "every launched browser must be closed after failure"
    );
    assert.equal(hf.hasActiveBrowser(), false);
  });
});
