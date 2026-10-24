import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AsyncMutex,
  AuthError,
  formatAuthToolError,
  MISSING_SESSION_MESSAGE,
  readOptionalPasswordCredentials,
  toAuthError,
} from "./auth.js";

describe("AuthError", () => {
  it("preserves code and is distinguishable from Error", () => {
    const err = AuthError.missingSession();
    assert.equal(err.name, "AuthError");
    assert.equal(err.code, "missing_session");
    assert.equal(err.message, MISSING_SESSION_MESSAGE);
    assert.ok(err instanceof AuthError);
    assert.ok(err instanceof Error);
    assert.equal(new Error("nope") instanceof AuthError, false);
  });

  it("maps codes used by the session-based design", () => {
    assert.equal(AuthError.expired().code, "expired");
    assert.equal(AuthError.invalidCredentials("bad").code, "invalid_credentials");
    assert.equal(AuthError.loginFailed("boom").code, "login_failed");
    assert.equal(new AuthError("challenge_sso", "Google SSO").code, "challenge_sso");
  });

  it("does not treat Google secrets as required in missing_session copy", () => {
    assert.match(MISSING_SESSION_MESSAGE, /run login again/i);
    assert.match(MISSING_SESSION_MESSAGE, /Continue with Google/);
    assert.doesNotMatch(MISSING_SESSION_MESSAGE, /GOOGLE_PASSWORD|GOOGLE_EMAIL/);
  });
});

describe("toAuthError / formatAuthToolError", () => {
  it("passes AuthError through", () => {
    const original = AuthError.expired("gone");
    const wrapped = toAuthError(original);
    assert.equal(wrapped, original);
  });

  it("wraps unknown errors as login_failed", () => {
    const wrapped = toAuthError(new Error("chromium crashed"));
    assert.equal(wrapped.code, "login_failed");
    assert.equal(wrapped.message, "chromium crashed");
  });

  it("serializes AuthError for MCP tool results", () => {
    const result = formatAuthToolError(AuthError.missingSession());
    assert.equal(result.isError, true);
    const payload = JSON.parse(result.content[0].text) as {
      error: string;
      message: string;
    };
    assert.equal(payload.error, "missing_session");
    assert.match(payload.message, /run login again/i);
  });

  it("keeps generic errors as Error: text", () => {
    const result = formatAuthToolError(new Error("zod fail"));
    assert.equal(result.content[0].text, "Error: zod fail");
  });
});

describe("readOptionalPasswordCredentials", () => {
  it("returns undefined when env is absent so Google SSO users are not blocked", () => {
    assert.equal(readOptionalPasswordCredentials({}), undefined);
    assert.equal(
      readOptionalPasswordCredentials({ HELLOFRESH_EMAIL: "a@b.c" }),
      undefined
    );
  });

  it("returns email/password only when both are set (optional fallback)", () => {
    assert.deepEqual(
      readOptionalPasswordCredentials({
        HELLOFRESH_EMAIL: "a@b.c",
        HELLOFRESH_PASSWORD: "secret",
      }),
      { email: "a@b.c", password: "secret" }
    );
  });
});

describe("AsyncMutex", () => {
  it("runs exclusive callbacks one at a time", async () => {
    const mutex = new AsyncMutex();
    const order: number[] = [];
    let current = 0;
    let maxConcurrent = 0;

    const job = (id: number) =>
      mutex.runExclusive(async () => {
        current += 1;
        maxConcurrent = Math.max(maxConcurrent, current);
        order.push(id);
        await new Promise((r) => setTimeout(r, 20));
        current -= 1;
        return id;
      });

    const results = await Promise.all([job(1), job(2), job(3)]);
    assert.deepEqual(results, [1, 2, 3]);
    assert.deepEqual(order, [1, 2, 3]);
    assert.equal(maxConcurrent, 1);
  });

  it("does not stall the queue after a rejection", async () => {
    const mutex = new AsyncMutex();
    await assert.rejects(
      mutex.runExclusive(async () => {
        throw new Error("boom");
      }),
      /boom/
    );
    const value = await mutex.runExclusive(async () => 42);
    assert.equal(value, 42);
  });
});
