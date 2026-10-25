import { mkdir, readFile, rename, chmod, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { AsyncMutex } from "./auth.js";
import { sha256Hex } from "./security.js";

export const OAUTH_STORE_ENV_VAR = "MCP_OAUTH_STORE_PATH";

export interface StoredOAuthClient {
  clientId: string;
  clientSecretHash: string | null;
  tokenEndpointAuthMethod: string;
  redirectUris: string[];
  clientName?: string;
  grantTypes: string[];
  responseTypes: string[];
  issuedAt: number;
}

export interface StoredAccessToken {
  kind: "access";
  clientId: string;
  refreshHash: string;
  expiresAt: number;
  scopes: string[];
  resource: string;
}

export interface StoredRefreshToken {
  kind: "refresh";
  clientId: string;
  accessHash: string;
  expiresAt: number;
  scopes: string[];
  resource: string;
}

export type StoredToken = StoredAccessToken | StoredRefreshToken;

interface StoreFile {
  clients: Record<string, StoredOAuthClient>;
  tokens: Record<string, StoredToken>;
}

const EMPTY_STORE: StoreFile = { clients: {}, tokens: {} };

export class OAuthStore {
  private readonly mutex = new AsyncMutex();
  private loaded: StoreFile | undefined;

  constructor(private readonly filePath: string) {}

  get path(): string {
    return this.filePath;
  }

  async getClient(clientId: string): Promise<StoredOAuthClient | undefined> {
    const data = await this.load();
    return data.clients[clientId];
  }

  async putClient(client: StoredOAuthClient): Promise<void> {
    await this.mutex.runExclusive(async () => {
      const data = await this.loadUnlocked();
      data.clients[client.clientId] = client;
      await this.saveUnlocked(data);
    });
  }

  async getToken(rawToken: string): Promise<StoredToken | undefined> {
    const data = await this.load();
    return data.tokens[sha256Hex(rawToken)];
  }

  async getTokenByHash(tokenHash: string): Promise<StoredToken | undefined> {
    const data = await this.load();
    return data.tokens[tokenHash];
  }

  async putTokenPair(input: {
    accessToken: string;
    refreshToken: string;
    clientId: string;
    accessExpiresAt: number;
    refreshExpiresAt: number;
    scopes: string[];
    resource: string;
    replaceAccessHash?: string;
    replaceRefreshHash?: string;
  }): Promise<void> {
    await this.mutex.runExclusive(async () => {
      const data = await this.loadUnlocked();
      this.pruneExpiredUnlocked(data);
      if (input.replaceAccessHash) {
        delete data.tokens[input.replaceAccessHash];
      }
      if (input.replaceRefreshHash) {
        delete data.tokens[input.replaceRefreshHash];
      }
      const accessHash = sha256Hex(input.accessToken);
      const refreshHash = sha256Hex(input.refreshToken);
      data.tokens[accessHash] = {
        kind: "access",
        clientId: input.clientId,
        refreshHash,
        expiresAt: input.accessExpiresAt,
        scopes: input.scopes,
        resource: input.resource,
      };
      data.tokens[refreshHash] = {
        kind: "refresh",
        clientId: input.clientId,
        accessHash,
        expiresAt: input.refreshExpiresAt,
        scopes: input.scopes,
        resource: input.resource,
      };
      await this.saveUnlocked(data);
    });
  }

  async revokeToken(rawToken: string): Promise<void> {
    await this.mutex.runExclusive(async () => {
      const data = await this.loadUnlocked();
      const hash = sha256Hex(rawToken);
      const record = data.tokens[hash];
      if (!record) {
        return;
      }
      delete data.tokens[hash];
      if (record.kind === "access") {
        delete data.tokens[record.refreshHash];
      } else {
        delete data.tokens[record.accessHash];
      }
      await this.saveUnlocked(data);
    });
  }

  private async load(): Promise<StoreFile> {
    return this.mutex.runExclusive(() => this.loadUnlocked());
  }

  private async loadUnlocked(): Promise<StoreFile> {
    if (this.loaded) {
      return this.loaded;
    }
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as StoreFile;
      this.loaded = {
        clients: parsed.clients && typeof parsed.clients === "object" ? parsed.clients : {},
        tokens: parsed.tokens && typeof parsed.tokens === "object" ? parsed.tokens : {},
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        throw error;
      }
      this.loaded = { clients: {}, tokens: {} };
    }
    return this.loaded;
  }

  private pruneExpiredUnlocked(data: StoreFile, now = Date.now() / 1000): void {
    for (const [hash, token] of Object.entries(data.tokens)) {
      if (token.expiresAt <= now) {
        delete data.tokens[hash];
      }
    }
  }

  private async saveUnlocked(data: StoreFile): Promise<void> {
    const dir = dirname(this.filePath);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.filePath}.tmp`;
    const json = JSON.stringify(data, null, 2);
    await writeFile(tmp, json, { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, this.filePath);
    await chmod(this.filePath, 0o600);
    this.loaded = data;
  }
}

export function emptyOAuthStoreFile(): StoreFile {
  return { clients: { ...EMPTY_STORE.clients }, tokens: { ...EMPTY_STORE.tokens } };
}
