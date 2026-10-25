import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const DATA_KEY_ENV = "MCP_DATA_KEY";
export const SECRET_BOX_ALG = "aes-256-gcm";

export type SecretPurpose = "account" | "session" | "oauth";

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class SecretBoxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretBoxError";
  }
}

interface SealedPayload {
  v: 1;
  alg: typeof SECRET_BOX_ALG;
  iv: string;
  tag: string;
  ct: string;
}

export interface SecretText {
  text: string;
  legacy: boolean;
}

/**
 * 32-byte AES-256 key from MCP_DATA_KEY (base64, base64url, or hex).
 * A short passphrase is rejected: this value is the key, not a password.
 */
export function loadDataKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = env[DATA_KEY_ENV]?.trim() ?? "";
  if (!raw) {
    throw new SecretBoxError(
      `MCP_DATA_KEY is required to read or write stored data. Generate one with: node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`
    );
  }
  const key = decodeKey(raw);
  if (!key) {
    throw new SecretBoxError(
      "MCP_DATA_KEY must be 32 bytes encoded as base64, base64url, or hex. A short passphrase is not accepted."
    );
  }
  return key;
}

export function seal(plaintext: string, key: Buffer, purpose: SecretPurpose): string {
  assertKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(SECRET_BOX_ALG, key, iv);
  cipher.setAAD(Buffer.from(purpose, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const payload: SealedPayload = {
    v: 1,
    alg: SECRET_BOX_ALG,
    iv: iv.toString("base64url"),
    tag: tag.toString("base64url"),
    ct: ct.toString("base64url"),
  };
  return JSON.stringify(payload);
}

export function open(sealed: string, key: Buffer, purpose: SecretPurpose): string {
  assertKey(key);
  const payload = parseSealed(sealed);
  if (!payload) {
    throw new SecretBoxError("Stored data is not sealed.");
  }
  const iv = decodePart(payload.iv);
  const tag = decodePart(payload.tag);
  const ct = decodePart(payload.ct);
  if (!iv || !tag || !ct || iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new SecretBoxError("Stored data is not sealed.");
  }
  try {
    const decipher = createDecipheriv(SECRET_BOX_ALG, key, iv);
    decipher.setAAD(Buffer.from(purpose, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    throw new SecretBoxError(
      "Cannot decrypt stored data. MCP_DATA_KEY is wrong, or the file was modified."
    );
  }
}

export function isSealed(raw: string): boolean {
  return parseSealed(raw) !== undefined;
}

/**
 * Read a sealed file. A legacy plaintext JSON file is returned only when the
 * key is configured; the next write seals it. Missing files return undefined.
 */
export async function readSecretText(
  path: string,
  purpose: SecretPurpose,
  env: NodeJS.ProcessEnv = process.env
): Promise<SecretText | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  if (isSealed(trimmed)) {
    return { text: open(trimmed, loadDataKey(env), purpose), legacy: false };
  }
  loadDataKey(env);
  return { text: trimmed, legacy: true };
}

/** Atomically write ciphertext with mode 0600. Parent directories are mode 0700. */
export async function writeSecretText(
  path: string,
  plaintext: string,
  purpose: SecretPurpose,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const sealed = seal(plaintext, loadDataKey(env), purpose);
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const tmp = `${path}.tmp`;
  await writeFile(tmp, sealed, { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
  await chmod(path, 0o600);
}

function assertKey(key: Buffer): void {
  if (key.length !== KEY_BYTES) {
    throw new SecretBoxError("MCP_DATA_KEY must be 32 bytes.");
  }
}

function decodeKey(raw: string): Buffer | undefined {
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, "hex");
  }
  if (/^[A-Za-z0-9_-]{43}$/.test(raw)) {
    const key = Buffer.from(raw, "base64url");
    return key.length === KEY_BYTES ? key : undefined;
  }
  if (/^[A-Za-z0-9+/]{43}=$/.test(raw)) {
    const key = Buffer.from(raw, "base64");
    return key.length === KEY_BYTES ? key : undefined;
  }
  return undefined;
}

function decodePart(value: string): Buffer | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    return undefined;
  }
  try {
    return Buffer.from(value, "base64url");
  } catch {
    return undefined;
  }
}

function parseSealed(raw: string): SealedPayload | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  if (
    record.v !== 1 ||
    record.alg !== SECRET_BOX_ALG ||
    typeof record.iv !== "string" ||
    typeof record.tag !== "string" ||
    typeof record.ct !== "string"
  ) {
    return undefined;
  }
  return {
    v: 1,
    alg: SECRET_BOX_ALG,
    iv: record.iv,
    tag: record.tag,
    ct: record.ct,
  };
}
