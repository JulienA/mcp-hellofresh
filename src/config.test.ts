import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ConfigError,
  DEFAULT_REDIRECT_HOSTS,
  loadHttpRuntimeConfig,
  redirectHostnameAllowed,
} from "./config.js";
import { sha256Hex } from "./security.js";

describe("loadHttpRuntimeConfig", () => {
  it("refuses HTTP mode without an owner secret", () => {
    assert.throws(
      () => loadHttpRuntimeConfig({ HOST: "127.0.0.1", PORT: "8090" }, []),
      (err: unknown) => {
        assert.ok(err instanceof ConfigError);
        assert.match(err.message, /MCP_OWNER_PASSWORD/);
        assert.doesNotMatch(err.message, /GOOGLE_PASSWORD/);
        return true;
      }
    );
  });

  it("accepts MCP_OWNER_PASSWORD_HASH and default redirect hosts", () => {
    const digest = sha256Hex("owner-secret");
    const config = loadHttpRuntimeConfig(
      {
        MCP_OWNER_PASSWORD_HASH: `sha256:${digest}`,
        HOST: "127.0.0.1",
        PORT: "8090",
      },
      []
    );
    assert.equal(config.ownerPasswordSha256Hex, digest);
    assert.deepEqual(config.redirectHosts, DEFAULT_REDIRECT_HOSTS);
    assert.equal(config.resourceUrl.pathname, "/mcp");
    assert.equal(config.issuer.protocol, "http:");
  });

  it("requires HTTPS PUBLIC_BASE_URL off localhost", () => {
    assert.throws(
      () =>
        loadHttpRuntimeConfig(
          {
            MCP_OWNER_PASSWORD: "secret",
            PUBLIC_BASE_URL: "http://example.com",
          },
          []
        ),
      /HTTPS/
    );
  });

  it("requires PUBLIC_BASE_URL when binding 0.0.0.0", () => {
    assert.throws(
      () =>
        loadHttpRuntimeConfig(
          { MCP_OWNER_PASSWORD: "secret", HOST: "0.0.0.0" },
          []
        ),
      /PUBLIC_BASE_URL/
    );
  });
});

describe("redirectHostnameAllowed", () => {
  const hosts = DEFAULT_REDIRECT_HOSTS;

  it("allows Claude and ChatGPT callback hosts", () => {
    assert.equal(
      redirectHostnameAllowed("https://claude.ai/api/mcp/auth_callback", hosts, true),
      true
    );
    assert.equal(
      redirectHostnameAllowed("https://claude.com/api/mcp/auth_callback", hosts, true),
      true
    );
    assert.equal(
      redirectHostnameAllowed(
        "https://chatgpt.com/connector_platform_oauth_redirect",
        hosts,
        true
      ),
      true
    );
  });

  it("allows loopback http redirects by default", () => {
    assert.equal(
      redirectHostnameAllowed("http://127.0.0.1:54321/callback", hosts, true),
      true
    );
    assert.equal(
      redirectHostnameAllowed("http://localhost:3000/callback", hosts, true),
      true
    );
  });

  it("rejects unknown hosts", () => {
    assert.equal(
      redirectHostnameAllowed("https://evil.example/callback", hosts, true),
      false
    );
    assert.equal(
      redirectHostnameAllowed("https://notclaude.ai/callback", hosts, true),
      false
    );
  });
});
