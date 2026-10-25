import { homedir } from "node:os";
import { join } from "node:path";
import { resolveUsersDir } from "./accounts.js";

export const DEFAULT_REDIRECT_HOSTS = ["claude.ai", "claude.com", "chatgpt.com"];
export const MCP_SCOPE = "mcp";

export const ACCESS_TOKEN_TTL_SEC = 60 * 60;
export const REFRESH_TOKEN_TTL_SEC = 60 * 60 * 24 * 30;
export const AUTH_CODE_TTL_SEC = 5 * 60;

export interface HttpRuntimeConfig {
  host: string;
  port: number;
  publicBaseUrl: URL;
  issuer: URL;
  resourceUrl: URL;
  authDbPath: string;
  usersDir: string;
  authSecret: string;
  redirectHosts: string[];
  allowLoopbackRedirects: boolean;
  dangerouslyAllowInsecureIssuerUrl: boolean;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

export function isLocalIssuer(url: URL): boolean {
  return isLoopbackHostname(url.hostname);
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function resolveAuthDbPath(env: NodeJS.ProcessEnv): string {
  if (env.MCP_AUTH_DB_PATH) {
    return env.MCP_AUTH_DB_PATH;
  }
  if (env.XDG_CONFIG_HOME) {
    return join(env.XDG_CONFIG_HOME, "mcp-hellofresh", "auth.sqlite");
  }
  if (process.platform === "win32") {
    const root = env.APPDATA || join(homedir(), "AppData", "Roaming");
    return join(root, "mcp-hellofresh", "auth.sqlite");
  }
  return join(homedir(), ".config", "mcp-hellofresh", "auth.sqlite");
}

function parseRedirectHosts(env: NodeJS.ProcessEnv): string[] {
  const raw = env.MCP_OAUTH_REDIRECT_HOSTS?.trim();
  if (!raw) {
    return [...DEFAULT_REDIRECT_HOSTS];
  }
  return raw
    .split(/[,\s]+/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function argvValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index >= 0 && argv[index + 1]) {
    return argv[index + 1];
  }
  const prefix = `${flag}=`;
  const matched = argv.find((item) => item.startsWith(prefix));
  return matched ? matched.slice(prefix.length) : undefined;
}

function resolveAuthSecret(env: NodeJS.ProcessEnv): string {
  const dedicated = env.BETTER_AUTH_SECRET?.trim();
  if (dedicated) {
    if (dedicated.length < 32) {
      throw new ConfigError("BETTER_AUTH_SECRET must be at least 32 characters.");
    }
    return dedicated;
  }
  return env.MCP_DATA_KEY?.trim() ?? "";
}

export function loadHttpRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv.slice(2)
): HttpRuntimeConfig {
  const host = argvValue(argv, "--host") || env.HOST || "127.0.0.1";
  const port = parsePositiveInt(argvValue(argv, "--port") || env.PORT, 8080);

  const publicBaseRaw = env.PUBLIC_BASE_URL?.trim();
  let publicBaseUrl: URL;
  if (publicBaseRaw) {
    try {
      publicBaseUrl = new URL(publicBaseRaw);
    } catch {
      throw new ConfigError("PUBLIC_BASE_URL must be an absolute URL.");
    }
  } else {
    if (host === "0.0.0.0" || host === "::") {
      throw new ConfigError(
        "PUBLIC_BASE_URL is required when HOST binds to all interfaces (0.0.0.0)."
      );
    }
    const hostname = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
    publicBaseUrl = new URL(`http://${hostname}:${port}`);
  }

  if (publicBaseUrl.hash || publicBaseUrl.search) {
    throw new ConfigError("PUBLIC_BASE_URL must not include a query or fragment.");
  }
  if (publicBaseUrl.protocol !== "https:" && !isLocalIssuer(publicBaseUrl)) {
    throw new ConfigError(
      "PUBLIC_BASE_URL must be HTTPS (HTTP is allowed only for localhost)."
    );
  }

  const issuer = new URL(publicBaseUrl.origin);
  const resourceUrl = new URL("/mcp", issuer);
  const authDbPath = resolveAuthDbPath(env);

  return {
    host,
    port,
    publicBaseUrl: issuer,
    issuer,
    resourceUrl,
    authDbPath,
    usersDir: resolveUsersDir(authDbPath, env),
    authSecret: resolveAuthSecret(env),
    redirectHosts: parseRedirectHosts(env),
    allowLoopbackRedirects: env.MCP_OAUTH_ALLOW_LOOPBACK !== "0",
    dangerouslyAllowInsecureIssuerUrl: isLocalIssuer(issuer),
  };
}

export function redirectHostnameAllowed(
  redirectUri: string,
  hosts: readonly string[],
  allowLoopback: boolean
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(redirectUri);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return false;
  }
  const hostname = parsed.hostname.toLowerCase();
  if (allowLoopback && isLoopbackHostname(hostname)) {
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  }
  if (parsed.protocol !== "https:") {
    return false;
  }
  return hosts.some((allowed) => {
    const needle = allowed.toLowerCase();
    return hostname === needle || hostname.endsWith(`.${needle}`);
  });
}
