import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { helloFreshCountry } from "./countries.js";
import { readSecretText, writeSecretText } from "./secret-box.js";
import { sha256Hex } from "./security.js";

export const ACCOUNT_ENV_VAR = "HELLOFRESH_ACCOUNT_PATH";
export const USERS_DIR_ENV_VAR = "MCP_USERS_DIR";

export interface StoredAccount {
  userId: string;
  email: string;
  country: string;
  accessToken: string;
  refreshToken?: string;
  issuedAt: number;
  expiresIn: number;
  refreshExpiresIn?: number;
  refreshIssuedAt?: number;
  tokenType?: string;
  savedAt: string;
}

export interface ParsedAuthBlob {
  accessToken: string;
  refreshToken?: string;
  issuedAt?: number;
  expiresIn?: number;
  refreshExpiresIn?: number;
  refreshIssuedAt?: number;
  tokenType?: string;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function userIdFor(country: string, email: string): string {
  const known = helloFreshCountry(country);
  if (!known) {
    throw new Error(`Unknown HelloFresh country: ${country}`);
  }
  return sha256Hex(`${known.code}\n${normalizeEmail(email)}`);
}

export function resolveUsersDir(authDbPath: string, env: NodeJS.ProcessEnv = process.env): string {
  if (env[USERS_DIR_ENV_VAR]?.trim()) {
    return env[USERS_DIR_ENV_VAR].trim();
  }
  return join(dirname(authDbPath), "users");
}

export function resolveStdioAccountPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env[ACCOUNT_ENV_VAR]?.trim()) {
    return env[ACCOUNT_ENV_VAR].trim();
  }
  if (env.XDG_CONFIG_HOME) {
    return join(env.XDG_CONFIG_HOME, "mcp-hellofresh", "account.json");
  }
  if (process.platform === "win32") {
    const root = env.APPDATA || join(homedir(), "AppData", "Roaming");
    return join(root, "mcp-hellofresh", "account.json");
  }
  return join(homedir(), ".config", "mcp-hellofresh", "account.json");
}

export function accountFilePath(usersDir: string, userId: string): string {
  if (!/^[0-9a-f]{64}$/.test(userId)) {
    throw new Error("Refusing to resolve an account path for an unexpected user id");
  }
  return join(usersDir, userId, "tokens.json");
}

export class AccountStore {
  constructor(private readonly usersDir: string) {}

  fileFor(userId: string): string {
    return accountFilePath(this.usersDir, userId);
  }

  async load(userId: string): Promise<StoredAccount | undefined> {
    return readStoredAccount(this.fileFor(userId));
  }

  async save(account: StoredAccount): Promise<void> {
    await writeStoredAccount(this.fileFor(account.userId), account);
  }

  async delete(userId: string): Promise<void> {
    const path = this.fileFor(userId);
    await rm(path, { force: true });
    await rm(`${path}.tmp`, { force: true });
  }
}

export async function readStoredAccount(path: string): Promise<StoredAccount | undefined> {
  const loaded = await readSecretText(path, "account");
  if (!loaded) {
    return undefined;
  }
  const parsed = JSON.parse(loaded.text) as StoredAccount;
  if (!parsed || typeof parsed !== "object" || typeof parsed.accessToken !== "string") {
    return undefined;
  }
  if (typeof parsed.userId !== "string" || typeof parsed.email !== "string") {
    return undefined;
  }
  return parsed;
}

export async function writeStoredAccount(path: string, account: StoredAccount): Promise<void> {
  const payload: StoredAccount = {
    userId: account.userId,
    email: account.email,
    country: account.country,
    accessToken: account.accessToken,
    refreshToken: account.refreshToken,
    issuedAt: account.issuedAt,
    expiresIn: account.expiresIn,
    refreshExpiresIn: account.refreshExpiresIn,
    refreshIssuedAt: account.refreshIssuedAt,
    tokenType: account.tokenType,
    savedAt: account.savedAt,
  };
  await writeSecretText(path, JSON.stringify(payload), "account");
}

export function decodeJwtClaims(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length < 2) {
    return undefined;
  }
  try {
    const json = Buffer.from(parts[1], "base64url").toString("utf8");
    const claims = JSON.parse(json) as unknown;
    return claims && typeof claims === "object" ? (claims as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export function emailFromClaims(claims: Record<string, unknown> | undefined): string | undefined {
  if (!claims) {
    return undefined;
  }
  for (const key of ["email", "username"]) {
    const value = claims[key];
    if (typeof value === "string" && value.includes("@")) {
      return normalizeEmail(value);
    }
  }
  return undefined;
}

function coerceInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return Math.trunc(Number(value));
  }
  return undefined;
}

function loadsPossiblyEncoded(text: string): unknown {
  let candidate = text.trim();
  for (let i = 0; i < 3; i += 1) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      try {
        const decoded = decodeURIComponent(candidate);
        if (decoded === candidate) {
          return undefined;
        }
        candidate = decoded;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/** Accept a raw or URL-encoded apiV2Auth object, or a bare access token. */
export function parseApiV2Auth(text: string | undefined): ParsedAuthBlob | undefined {
  if (!text?.trim()) {
    return undefined;
  }
  const parsed = loadsPossiblyEncoded(text);
  let accessToken: string | undefined;
  let payload: Record<string, unknown> = {};
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    payload = parsed as Record<string, unknown>;
    if (typeof payload.access_token === "string") {
      accessToken = payload.access_token.trim();
    }
  } else if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(text.trim())) {
    accessToken = text.trim();
  }
  if (!accessToken) {
    return undefined;
  }
  const claims = decodeJwtClaims(accessToken);
  const issuedAt = coerceInt(payload.issued_at) ?? coerceInt(claims?.iat);
  let expiresIn = coerceInt(payload.expires_in);
  const exp = coerceInt(claims?.exp);
  if (expiresIn === undefined && exp !== undefined && issuedAt !== undefined) {
    expiresIn = exp - issuedAt;
  }
  const refresh = payload.refresh_token;
  return {
    accessToken,
    refreshToken: typeof refresh === "string" && refresh.trim() ? refresh.trim() : undefined,
    issuedAt,
    expiresIn,
    refreshExpiresIn: coerceInt(payload.refresh_expires_in),
    refreshIssuedAt: coerceInt(payload.refresh_token_issued_at) ?? issuedAt,
    tokenType: typeof payload.token_type === "string" ? payload.token_type : undefined,
  };
}

export function findEmail(value: unknown, depth = 0): string | undefined {
  if (depth > 5 || value == null) {
    return undefined;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findEmail(item, depth + 1);
      if (found) {
        return found;
      }
    }
    return undefined;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["email", "username", "customerEmail"]) {
      const candidate = record[key];
      if (typeof candidate === "string" && candidate.includes("@")) {
        return normalizeEmail(candidate);
      }
    }
    for (const nested of Object.values(record)) {
      const found = findEmail(nested, depth + 1);
      if (found) {
        return found;
      }
    }
  }
  return undefined;
}
