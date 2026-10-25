import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ConfigError,
  DEFAULT_REDIRECT_HOSTS,
  loadHttpRuntimeConfig,
  redirectHostnameAllowed,
} from "./config.js";

describe("loadHttpRuntimeConfig", () => {
  it("starts without an owner secret or static bearer", () => {
    const config = loadHttpRuntimeConfig({ HOST: "127.0.0.1", PORT: "8090" }, []);
    assert.equal(config.host, "127.0.0.1");
    assert.equal(config.port, 8090);
    assert.deepEqual(config.redirectHosts, DEFAULT_REDIRECT_HOSTS);
    assert.equal(config.resourceUrl.pathname, "/mcp");
    assert.equal(config.issuer.protocol, "http:");
    assert.equal(config.usersDir.endsWith("/users") || config.usersDir.endsWith("\\users"), true);
    assert.equal("ownerPasswordSha256Hex" in config, false);
    assert.equal("bearerToken" in config, false);
  });

  it("honors MCP_USERS_DIR", () => {
    const config = loadHttpRuntimeConfig(
      { HOST: "127.0.0.1", PORT: "8090", MCP_USERS_DIR: "/var/lib/mcp-hellofresh/users" },
      []
    );
    assert.equal(config.usersDir, "/var/lib/mcp-hellofresh/users");
  });

  it("honors MCP_AUTH_DB_PATH and BETTER_AUTH_SECRET", () => {
    const config = loadHttpRuntimeConfig(
      {
        HOST: "127.0.0.1",
        PORT: "8090",
        MCP_AUTH_DB_PATH: "/data/auth.sqlite",
        BETTER_AUTH_SECRET: "a".repeat(32),
      },
      []
    );
    assert.equal(config.authDbPath, "/data/auth.sqlite");
    assert.equal(config.usersDir, "/data/users");
    assert.equal(config.authSecret, "a".repeat(32));
  });

  it("rejects a short BETTER_AUTH_SECRET", () => {
    assert.throws(
      () =>
        loadHttpRuntimeConfig(
          { HOST: "127.0.0.1", BETTER_AUTH_SECRET: "too-short" },
          []
        ),
      (err: unknown) => {
        assert.ok(err instanceof ConfigError);
        assert.match(err.message, /BETTER_AUTH_SECRET/);
        return true;
      }
    );
  });

  it("requires HTTPS PUBLIC_BASE_URL off localhost", () => {
    assert.throws(
      () =>
        loadHttpRuntimeConfig(
          {
            PUBLIC_BASE_URL: "http://example.com",
          },
          []
        ),
      (err: unknown) => {
        assert.ok(err instanceof ConfigError);
        assert.match(err.message, /HTTPS/);
        return true;
      }
    );
  });

  it("requires PUBLIC_BASE_URL when binding 0.0.0.0", () => {
    assert.throws(
      () => loadHttpRuntimeConfig({ HOST: "0.0.0.0" }, []),
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
