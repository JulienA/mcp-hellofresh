import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { readSecretText, writeSecretText } from "./secret-box.js";

export const SESSION_ENV_VAR = "HELLOFRESH_SESSION_PATH";
export const DEFAULT_SESSION_FILENAME = "session.json";

export interface PlaywrightCookie {
  name: string;
  value: string;
  domain: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

export interface PlaywrightOrigin {
  origin: string;
  localStorage?: Array<{ name: string; value: string }>;
}

export interface PlaywrightStorageState {
  cookies: PlaywrightCookie[];
  origins: PlaywrightOrigin[];
}

export interface PersistedSession {
  savedAt: string;
  storageState: PlaywrightStorageState;
}

export function resolveSessionPath(
  env: NodeJS.ProcessEnv = process.env,
  override?: string
): string {
  if (override) {
    return override;
  }
  const fromEnv = env[SESSION_ENV_VAR];
  if (fromEnv) {
    return fromEnv;
  }
  if (env.XDG_CONFIG_HOME) {
    return join(env.XDG_CONFIG_HOME, "mcp-hellofresh", DEFAULT_SESSION_FILENAME);
  }
  if (process.platform === "win32") {
    const root = env.APPDATA || join(homedir(), "AppData", "Roaming");
    return join(root, "mcp-hellofresh", DEFAULT_SESSION_FILENAME);
  }
  return join(homedir(), ".config", "mcp-hellofresh", DEFAULT_SESSION_FILENAME);
}

export function isHelloFreshHost(domainOrHost: string): boolean {
  const host = domainOrHost.replace(/^\./, "").toLowerCase();
  return /(^|\.)hellofresh\./i.test(host);
}

export function isHelloFreshLoggedInUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (!isHelloFreshHost(parsed.hostname)) {
      return false;
    }
    const path = parsed.pathname;
    if (path.includes("/login") && !path.includes("/login/success")) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function toPlaywrightStorageState(state: PlaywrightStorageState): {
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: "Strict" | "Lax" | "None";
  }>;
  origins: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>;
} {
  return {
    cookies: (state.cookies ?? []).map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path ?? "/",
      expires: cookie.expires ?? -1,
      httpOnly: cookie.httpOnly ?? false,
      secure: cookie.secure ?? true,
      sameSite: cookie.sameSite ?? "Lax",
    })),
    origins: (state.origins ?? []).map((origin) => ({
      origin: origin.origin,
      localStorage: origin.localStorage ?? [],
    })),
  };
}

export function filterHelloFreshStorageState(
  state: PlaywrightStorageState
): PlaywrightStorageState {
  return {
    cookies: (state.cookies ?? []).filter((cookie) => isHelloFreshHost(cookie.domain)),
    origins: (state.origins ?? []).filter((origin) => {
      try {
        return isHelloFreshHost(new URL(origin.origin).hostname);
      } catch {
        return false;
      }
    }),
  };
}

export function helloFreshCookiesAreValid(
  state: PlaywrightStorageState,
  nowMs: number = Date.now()
): boolean {
  const cookies = filterHelloFreshStorageState(state).cookies;
  if (cookies.length === 0) {
    return false;
  }
  const nowSec = nowMs / 1000;
  return cookies.some((cookie) => {
    const expires = cookie.expires ?? -1;
    return expires === -1 || expires > nowSec;
  });
}

export async function loadPersistedSession(
  path: string
): Promise<PersistedSession | undefined> {
  const loaded = await readSecretText(path, "session");
  if (!loaded) {
    return undefined;
  }
  const parsed = JSON.parse(loaded.text) as PersistedSession;
  if (!parsed || typeof parsed !== "object" || !parsed.storageState) {
    return undefined;
  }
  const storageState = filterHelloFreshStorageState(parsed.storageState);
  if (storageState.cookies.length === 0 && storageState.origins.length === 0) {
    return undefined;
  }
  return {
    savedAt: typeof parsed.savedAt === "string" ? parsed.savedAt : new Date(0).toISOString(),
    storageState,
  };
}

export async function savePersistedSession(
  path: string,
  storageState: PlaywrightStorageState,
  savedAt: Date = new Date()
): Promise<PersistedSession> {
  const filtered = filterHelloFreshStorageState(storageState);
  const payload: PersistedSession = {
    savedAt: savedAt.toISOString(),
    storageState: filtered,
  };
  await writeSecretText(path, JSON.stringify(payload), "session");
  return payload;
}

export async function deletePersistedSession(path: string): Promise<void> {
  await rm(path, { force: true });
  await rm(`${path}.tmp`, { force: true });
}
