import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { userIdFor } from "./accounts.js";
import { helloFreshUserContext, requestLogContext } from "./request-context.js";
import {
  captureLogLines,
  errorCode,
  log,
  logPath,
  parseLogLevel,
  sanitizeFields,
  setLogLevel,
  shortUserId,
} from "./log.js";

describe("log helpers", () => {
  it("parses LOG_LEVEL and defaults to info", () => {
    assert.equal(parseLogLevel(undefined), "info");
    assert.equal(parseLogLevel("DEBUG"), "debug");
    assert.equal(parseLogLevel("nope"), "info");
  });

  it("shortens hex account ids and drops emails", () => {
    const id = userIdFor("fr", "alice@example.com");
    assert.equal(shortUserId(id), id.slice(0, 12));
    assert.equal(shortUserId("alice@example.com"), undefined);
    assert.equal(shortUserId("pending"), undefined);
  });

  it("strips query strings from paths", () => {
    assert.equal(logPath("/authorize?code=secret"), "/authorize");
    assert.equal(logPath("https://www.hellofresh.fr/gw/login?country=fr"), "/gw/login");
  });

  it("redacts secrets, emails, and bearer values", () => {
    const cleaned = sanitizeFields({
      password: "correct-hf-password",
      email: "alice@example.com",
      authorization: "Bearer mcp_abc",
      api_v2_auth: "header.payload.sig",
      refresh_token: "mcr_secret",
      userId: userIdFor("fr", "alice@example.com"),
      path: "/token?code=aaaaaaaaaaaaaaaaaaaaaaaaaa",
      country: "fr",
      grantType: "authorization_code",
      code: "invalid_grant",
    });
    assert.equal(cleaned.password, "[redacted]");
    assert.equal(cleaned.email, "[redacted]");
    assert.equal(cleaned.authorization, "[redacted]");
    assert.equal(cleaned.api_v2_auth, "[redacted]");
    assert.equal(cleaned.refresh_token, "[redacted]");
    assert.equal(cleaned.userId, userIdFor("fr", "alice@example.com").slice(0, 12));
    assert.equal(cleaned.path, "/token");
    assert.equal(cleaned.country, "fr");
    assert.equal(cleaned.grantType, "authorization_code");
    assert.equal(cleaned.code, "invalid_grant");
    assert.equal(JSON.stringify(cleaned).includes("alice@"), false);
    assert.equal(JSON.stringify(cleaned).includes("correct-hf-password"), false);
  });

  it("reads error codes from AuthError-shaped objects", () => {
    assert.equal(errorCode({ code: "invalid_credentials" }), "invalid_credentials");
    assert.equal(errorCode(new Error("nope")), undefined);
  });
});

describe("log emit", () => {
  it("writes JSON lines at the configured level and attaches request context", () => {
    const previous = process.env.LOG_LEVEL;
    setLogLevel("info");
    const captured = captureLogLines();
    try {
      requestLogContext.run({ requestId: "reqtest01" }, () => {
        helloFreshUserContext.run(userIdFor("fr", "alice@example.com"), () => {
          log.debug("skipped");
          log.info("http.request", { method: "GET", path: "/healthz", status: 200 });
          log.warn("oauth.authorize", {
            outcome: "rejected",
            password: "should-not-appear",
            email: "alice@example.com",
          });
        });
      });
      const records = captured.records();
      assert.equal(records.length, 2);
      assert.equal(records[0]?.msg, "http.request");
      assert.equal(records[0]?.level, "info");
      assert.equal(records[0]?.requestId, "reqtest01");
      assert.equal(records[0]?.userId, userIdFor("fr", "alice@example.com").slice(0, 12));
      assert.equal(records[1]?.msg, "oauth.authorize");
      assert.equal(records[1]?.password, "[redacted]");
      assert.equal(records[1]?.email, "[redacted]");
      const blob = captured.lines.join("\n");
      assert.equal(blob.includes("should-not-appear"), false);
      assert.equal(blob.includes("alice@example.com"), false);
    } finally {
      captured.restore();
      setLogLevel(previous);
    }
  });
});
