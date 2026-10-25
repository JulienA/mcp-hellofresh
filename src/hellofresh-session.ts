import { rm } from "node:fs/promises";
import { readOptionalPasswordCredentials } from "./auth.js";
import {
  readStoredAccount,
  resolveStdioAccountPath,
  writeStoredAccount,
  type AccountStore,
  type StoredAccount,
} from "./accounts.js";
import {
  HelloFreshApi,
  HelloFreshApiError,
  RECONNECT_MESSAGE,
  type AccountStatus,
  type FetchLike,
} from "./hellofresh-api.js";

export const STDIO_RECONNECT_MESSAGE =
  "No HelloFresh account is saved on this machine. Run `npm run login` and finish Continue with Google in the window, or set HELLOFRESH_EMAIL and HELLOFRESH_PASSWORD for a HelloFresh password account. Do not send a Google password.";

export interface HelloFreshSession {
  status(): Promise<AccountStatus>;
  logout(): Promise<void>;
  api(): Promise<HelloFreshApi>;
  login?(): Promise<{ savedAt: string; email: string; country: string }>;
}

const SIGNED_OUT: AccountStatus = {
  authenticated: false,
  email: null,
  country: null,
  accessTokenValid: false,
  savedAt: null,
  reconnectRequired: true,
};

export class AccountClients {
  private readonly clients = new Map<string, HelloFreshApi>();

  constructor(
    private readonly store: AccountStore,
    private readonly fetchImpl: FetchLike = fetch
  ) {}

  sessionFor(userId: string): HelloFreshSession {
    return {
      status: async () => {
        const account = await this.store.load(userId);
        if (!account) {
          return SIGNED_OUT;
        }
        return {
          authenticated: true,
          email: account.email,
          country: account.country,
          accessTokenValid: account.issuedAt + account.expiresIn > Math.floor(Date.now() / 1000),
          savedAt: account.savedAt,
          reconnectRequired: false,
        };
      },
      logout: async () => {
        this.clients.delete(userId);
        await this.store.delete(userId);
      },
      api: () => this.clientFor(userId),
    };
  }

  private async clientFor(userId: string): Promise<HelloFreshApi> {
    const cached = this.clients.get(userId);
    if (cached) {
      return cached;
    }
    const account = await this.store.load(userId);
    if (!account) {
      throw new HelloFreshApiError("reconnect_required", RECONNECT_MESSAGE);
    }
    const client = new HelloFreshApi(account, this.fetchImpl, {
      onUpdate: async (next) => {
        await this.store.save(next);
      },
    });
    this.clients.set(userId, client);
    return client;
  }
}

export function createStdioSession(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: FetchLike = fetch
): HelloFreshSession {
  const path = resolveStdioAccountPath(env);
  let cached: HelloFreshApi | undefined;

  const persist = async (account: StoredAccount): Promise<void> => {
    await writeStoredAccount(path, account);
  };

  const relogin = async (): Promise<StoredAccount> => {
    const creds = readOptionalPasswordCredentials(env);
    const country = env.HELLOFRESH_COUNTRY?.trim() || "us";
    if (!creds) {
      throw new HelloFreshApiError("reconnect_required", STDIO_RECONNECT_MESSAGE);
    }
    const api = await HelloFreshApi.login({
      email: creds.email,
      password: creds.password,
      country,
      fetchImpl,
    });
    const stored = api.toStoredAccount();
    await persist(stored);
    cached = new HelloFreshApi(stored, fetchImpl, { onUpdate: persist, relogin });
    return stored;
  };

  return {
    status: async () => {
      const account = await readStoredAccount(path);
      if (!account) {
        return { ...SIGNED_OUT, reconnectRequired: true };
      }
      return {
        authenticated: true,
        email: account.email,
        country: account.country,
        accessTokenValid: account.issuedAt + account.expiresIn > Math.floor(Date.now() / 1000),
        savedAt: account.savedAt,
        reconnectRequired: false,
      };
    },
    logout: async () => {
      cached = undefined;
      await rm(path, { force: true });
      await rm(`${path}.tmp`, { force: true });
    },
    api: async () => {
      if (cached) {
        return cached;
      }
      const existing = await readStoredAccount(path);
      if (!existing) {
        const stored = await relogin();
        cached = new HelloFreshApi(stored, fetchImpl, { onUpdate: persist, relogin });
        return cached;
      }
      cached = new HelloFreshApi(existing, fetchImpl, { onUpdate: persist, relogin });
      return cached;
    },
    login: async () => {
      const { captureHelloFreshAccount } = await import("./login-browser.js");
      const country = env.HELLOFRESH_COUNTRY?.trim() || "us";
      const stored = await captureHelloFreshAccount({ country, fetchImpl });
      await persist(stored);
      cached = new HelloFreshApi(stored, fetchImpl, { onUpdate: persist, relogin });
      return { savedAt: stored.savedAt, email: stored.email, country: stored.country };
    },
  };
}
