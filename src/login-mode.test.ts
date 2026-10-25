import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AuthError } from "./auth.js";
import {
  HEADLESS_LOGIN_MESSAGE,
  HTTP_LOGIN_MESSAGE,
  assertInteractiveLoginAllowed,
  interactiveLoginBlockedReason,
  isHttpMode,
} from "./login-mode.js";

describe("isHttpMode", () => {
  it("is enabled by --http or MCP_HTTP", () => {
    assert.equal(isHttpMode(["--http"], {}), true);
    assert.equal(isHttpMode([], { MCP_HTTP: "1" }), true);
    assert.equal(isHttpMode([], { MCP_HTTP: "true" }), true);
    assert.equal(isHttpMode([], {}), false);
  });
});

describe("interactive login guard", () => {
  it("tells HTTP mode to reconnect the connector", () => {
    const reason = interactiveLoginBlockedReason({ httpMode: true, env: { DISPLAY: ":0" } });
    assert.equal(reason, HTTP_LOGIN_MESSAGE);
    assert.match(reason ?? "", /authorize/);
    assert.match(reason ?? "", /apiV2Auth/);
    assert.doesNotMatch(reason ?? "", /HELLOFRESH_SESSION_PATH/);
    assert.doesNotMatch(reason ?? "", /GOOGLE_PASSWORD/);
  });

  it("blocks headless Linux without a display unless a headed launcher is injected", () => {
    const env = { DISPLAY: undefined, WAYLAND_DISPLAY: undefined } as unknown as NodeJS.ProcessEnv;
    if (process.platform === "linux") {
      const reason = interactiveLoginBlockedReason({ env, hasInjectedHeadedLauncher: false });
      assert.equal(reason, HEADLESS_LOGIN_MESSAGE);
      assert.match(reason ?? "", /npm run login/);
    }
    assert.equal(
      interactiveLoginBlockedReason({ env, hasInjectedHeadedLauncher: true }),
      undefined
    );
  });

  it("throws AuthError.login_failed", () => {
    assert.throws(
      () => assertInteractiveLoginAllowed({ httpMode: true }),
      (err: unknown) => {
        assert.ok(err instanceof AuthError);
        assert.equal(err.code, "login_failed");
        return true;
      }
    );
  });
});
