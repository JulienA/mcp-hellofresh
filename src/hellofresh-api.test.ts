import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { AccountStore, userIdFor, type StoredAccount } from "./accounts.js";
import { createAccountLinker } from "./account-linker.js";
import {
  HelloFreshApi,
  HelloFreshApiError,
  type FetchLike,
} from "./hellofresh-api.js";
import { AccountClients, createStdioSession } from "./hellofresh-session.js";
import { setLogSink } from "./log.js";

setLogSink(() => {});

const WEEK = "2099-W01";

interface Call {
  url: string;
  method: string;
  authorization: string;
  body: string;
  origin: string;
}

function headerValue(headers: HeadersInit | undefined, name: string): string {
  if (!headers) {
    return "";
  }
  if (headers instanceof Headers) {
    return headers.get(name) ?? "";
  }
  if (Array.isArray(headers)) {
    const found = headers.find(([key]) => key.toLowerCase() === name.toLowerCase());
    return found?.[1] ?? "";
  }
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) {
      return value;
    }
  }
  return "";
}

function recorded(handler: (call: Call) => Response): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const call = {
      url: String(input),
      method: init?.method ?? "GET",
      authorization: headerValue(init?.headers, "Authorization"),
      body: typeof init?.body === "string" ? init.body : "",
      origin: headerValue(init?.headers, "Origin"),
    };
    calls.push(call);
    return handler(call);
  };
  return { fetchImpl, calls };
}

function subscriptionBody(): unknown {
  return {
    items: [
      {
        id: "sub-1",
        customerPlanId: "plan-1",
        customer: { id: "cust-1" },
        preset: "chefschoice",
        locale: "fr-FR",
        shippingAddress: { postcode: "75011" },
        deliveryOption: { handle: "FR-1-0800-1600" },
        product: { sku: "FR-CBT-3-2-0", specs: { meals: 3, size: 2 } },
        deliveryInterval: 1,
        status: "active",
        productType: { family: { handle: "classic-box" } },
      },
    ],
  };
}

function okAccount(call: Call): Response | undefined {
  if (call.url.includes("/customers/me/subscriptions")) {
    return Response.json(subscriptionBody());
  }
  if (call.url.includes("/customers/me/info")) {
    return Response.json({ email: "ada@example.com" });
  }
  if (call.url.includes("/customers/me/deliveries")) {
    return Response.json({
      items: [
        {
          id: WEEK,
          deliveryDate: "2099-01-06T00:00:00+0000",
          cutoffDate: "2099-01-04T23:59:59+0000",
          status: "RUNNING",
          subscriptionId: "sub-1",
          product: { handle: "FR-CBT-3-2-0" },
        },
      ],
    });
  }
  if (call.url.includes("/my-deliveries/menu")) {
    return Response.json({
      week: WEEK,
      meals: [{ index: 4, recipe: { id: "recipe-9", name: "Tacos", headline: "Crispy" } }],
    });
  }
  if (call.url.includes("/gw/v1/carts/")) {
    return Response.json({ ok: true });
  }
  if (call.url.includes("/delivery_dates_options")) {
    return Response.json({
      items: [
        {
          deliveryDate: "2099-01-08T00:00:00+0000",
          deliveryOptions: [{ handle: "FR-2-0900", deliveryDate: "2099-01-08T00:00:00+0000" }],
        },
      ],
    });
  }
  if (call.url.includes("/oneoff") || call.url.includes("/delivery_dates/") || call.url.includes("/plans/")) {
    return new Response(null, { status: 204 });
  }
  if (call.url.includes("/product_options")) {
    return Response.json({ items: [{ handle: "FR-CBT-4-2-0", meals: 4, size: 2 }] });
  }
  if (call.url.includes("/profile")) {
    return Response.json({ taste: { dietaryPreferences: ["pork-free"], exclusions: ["nuts"] } });
  }
  if (call.url.includes("/past-deliveries")) {
    return Response.json({ weeks: [{ id: "2020-W01", deliveryDate: "2020-01-01", status: "DELIVERED" }] });
  }
  if (call.url.includes("/recipes/recipes/")) {
    return Response.json({ id: "recipe-9", name: "Tacos" });
  }
  return undefined;
}

describe("HelloFreshApi.login", () => {
  it("posts /gw/login for France and checks subscriptions before returning", async () => {
    const { fetchImpl, calls } = recorded((call) => {
      if (call.url.includes("/gw/login")) {
        assert.equal(call.origin, "https://www.hellofresh.fr");
        assert.match(call.url, /country=FR/);
        assert.match(call.url, /locale=fr-FR/);
        const body = JSON.parse(call.body) as { username: string; password: string };
        assert.equal(body.username, "Ada@Example.com");
        assert.equal(body.password, "correct-password");
        return Response.json({
          access_token: "issued-access",
          refresh_token: "issued-refresh",
          expires_in: 1800,
          token_type: "Bearer",
        });
      }
      return okAccount(call) ?? Response.json({ message: "missing" }, { status: 404 });
    });
    const api = await HelloFreshApi.login({
      email: "Ada@Example.com",
      password: "correct-password",
      country: "fr",
      fetchImpl,
    });
    assert.equal(api.email, "ada@example.com");
    assert.equal(api.toStoredAccount().userId, userIdFor("fr", "ada@example.com"));
    const subscriptionAt = calls.findIndex((call) => call.url.includes("/subscriptions"));
    const loginAt = calls.findIndex((call) => call.url.includes("/gw/login"));
    assert.ok(loginAt >= 0 && subscriptionAt > loginAt);
    assert.equal(api.toStoredAccount().accessToken, "issued-access");
    assert.equal(JSON.stringify(api.toStoredAccount()).includes("correct-password"), false);
  });

  it("treats a rejected password as invalid credentials and does not retry", async () => {
    const { fetchImpl, calls } = recorded(
      () => Response.json({ message: "bad password for ada@example.com" }, { status: 401 })
    );
    await assert.rejects(
      () =>
        HelloFreshApi.login({
          email: "ada@example.com",
          password: "nope",
          country: "fr",
          fetchImpl,
        }),
      (error: unknown) => {
        assert.ok(error instanceof HelloFreshApiError);
        assert.equal(error.code, "invalid_credentials");
        assert.doesNotMatch(error.message, /ada@example.com|nope/);
        return true;
      }
    );
    assert.equal(calls.length, 1);
  });

  it("honors 429 without sending the password again", async () => {
    const { fetchImpl, calls } = recorded(() => Response.json({ message: "slow down" }, { status: 429 }));
    await assert.rejects(
      () =>
        HelloFreshApi.login({
          email: "ada@example.com",
          password: "nope",
          country: "fr",
          fetchImpl,
        }),
      (error: unknown) => {
        assert.ok(error instanceof HelloFreshApiError);
        assert.equal(error.code, "rate_limited");
        return true;
      }
    );
    assert.equal(calls.length, 1);
  });

  it("tells a social-only account to use the pasted token", async () => {
    const { fetchImpl } = recorded(() =>
      Response.json({ message: "Please continue with Google" }, { status: 401 })
    );
    await assert.rejects(
      () =>
        HelloFreshApi.login({
          email: "ada@example.com",
          password: "nope",
          country: "fr",
          fetchImpl,
        }),
      (error: unknown) => {
        assert.ok(error instanceof HelloFreshApiError);
        assert.match(error.message, /paste apiV2Auth/);
        assert.doesNotMatch(error.message, /nope/);
        return true;
      }
    );
  });

  it("surfaces a Cloudflare block as a bot block, not a bad password", async () => {
    const { fetchImpl } = recorded(
      () =>
        new Response("<html>Just a moment</html>", {
          status: 403,
          headers: { "content-type": "text/html" },
        })
    );
    await assert.rejects(
      () =>
        HelloFreshApi.login({
          email: "ada@example.com",
          password: "correct-password",
          country: "uk",
          fetchImpl,
        }),
      (error: unknown) => {
        assert.ok(error instanceof HelloFreshApiError);
        assert.equal(error.code, "bot_blocked");
        assert.match(error.message, /not a wrong password/i);
        return true;
      }
    );
  });
});

describe("HelloFreshApi.fromPasted", () => {
  it("creates the account only after subscriptions validate the token", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hf-link-"));
    const store = new AccountStore(dir);
    let subscriptions = 0;
    const { fetchImpl } = recorded((call) => {
      if (call.url.includes("/subscriptions")) {
        subscriptions += 1;
        assert.equal(call.authorization, "Bearer pasted-access");
        return Response.json(subscriptionBody());
      }
      if (call.url.includes("/customers/me/info")) {
        return Response.json({ email: "ada@example.com" });
      }
      return Response.json({}, { status: 404 });
    });
    const linker = createAccountLinker(store, fetchImpl);
    const before = await store.load(userIdFor("fr", "ada@example.com"));
    assert.equal(before, undefined);
    const linked = await linker.linkWithToken({
      country: "fr",
      token: JSON.stringify({
        access_token: "pasted-access",
        refresh_token: "pasted-refresh",
        expires_in: 1800,
        noise: "discard-me",
      }),
    });
    assert.equal(subscriptions, 1);
    assert.equal(linked.userId, userIdFor("fr", "ada@example.com"));
    const saved = await readFile(store.fileFor(linked.userId), "utf8");
    assert.equal(saved.includes("discard-me"), false);
    assert.match(saved, /pasted-access/);
  });
});

describe("HelloFreshApi requests", () => {
  it("refreshes before an expired access token and stores the new pair", async () => {
    const updates: StoredAccount[] = [];
    const now = Math.floor(Date.now() / 1000);
    const { fetchImpl, calls } = recorded((call) => {
      if (call.url.includes("/gw/refresh")) {
        assert.equal(JSON.parse(call.body).refresh_token, "old-refresh");
        return Response.json({
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_in: 1800,
        });
      }
      if (call.url.includes("/subscriptions")) {
        assert.equal(call.authorization, "Bearer new-access");
      }
      return okAccount(call) ?? Response.json({}, { status: 404 });
    });
    const api = new HelloFreshApi(stored("old-access", now - 100, 30), fetchImpl, {
      onUpdate: async (next) => {
        updates.push(next);
      },
    });
    const menu = await api.getMenu(0);
    assert.equal(menu.weekId, WEEK);
    assert.equal(menu.recipes[0]?.name, "Tacos");
    assert.equal(updates.at(-1)?.accessToken, "new-access");
    assert.ok(calls.some((call) => call.url.includes("/gw/refresh")));
  });

  it("asks to reconnect when refresh is rejected and no password is kept", async () => {
    let relogins = 0;
    const { fetchImpl, calls } = recorded((call) => {
      if (call.url.includes("/gw/refresh")) {
        return Response.json({ message: "expired" }, { status: 401 });
      }
      return okAccount(call) ?? Response.json({}, { status: 404 });
    });
    const api = new HelloFreshApi(stored("old-access", Math.floor(Date.now() / 1000) - 100, 30), fetchImpl, {
      relogin: async () => {
        relogins += 1;
        return stored("relogin-access", Math.floor(Date.now() / 1000), 1800);
      },
    });
    await api.getSubscription();
    assert.equal(relogins, 1);
    assert.equal(calls.filter((call) => call.url.includes("/gw/refresh")).length, 1);
    const again = new HelloFreshApi(stored("old-access", Math.floor(Date.now() / 1000) - 100, 30), fetchImpl);
    await assert.rejects(() => again.getSubscription(), (error: unknown) => {
      assert.ok(error instanceof HelloFreshApiError);
      assert.equal(error.code, "reconnect_required");
      assert.match(error.message, /Disconnect the connector/);
      return true;
    });
  });

  it("puts the selected meals on the cart", async () => {
    const { fetchImpl, calls } = recorded((call) => okAccount(call) ?? Response.json({}, { status: 404 }));
    const api = new HelloFreshApi(stored("access", Math.floor(Date.now() / 1000), 1800), fetchImpl);
    await api.selectMeals(WEEK, [{ recipeId: "recipe-9", servings: 1 }]);
    await api.selectMeals(WEEK, [{ recipeId: "recipe-9" }]);
    const puts = calls.filter((call) => call.method === "PUT");
    assert.equal(puts.length, 2);
    assert.match(puts[0].url, /\/gw\/v1\/carts\/2099-W01/);
    assert.match(puts[0].url, /customer=cust-1/);
    assert.match(puts[0].url, /product-sku=FR-CBT-3-2-0/);
    const explicit = JSON.parse(puts[0].body) as { meals: Array<{ index: number; quantity: number }> };
    const fallback = JSON.parse(puts[1].body) as { meals: Array<{ index: number; quantity: number }> };
    assert.deepEqual(explicit.meals, [{ index: 4, quantity: 1 }]);
    assert.deepEqual(fallback.meals, [{ index: 4, quantity: 2 }]);
  });

  it("uses a different bearer for each saved account", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hf-clients-"));
    const store = new AccountStore(dir);
    const alice = stored("alice-access", Math.floor(Date.now() / 1000), 1800);
    const bob = { ...stored("bob-access", Math.floor(Date.now() / 1000), 1800), email: "bob@example.com" };
    bob.userId = userIdFor("fr", bob.email);
    await store.save(alice);
    await store.save(bob);
    const { fetchImpl, calls } = recorded((call) => okAccount(call) ?? Response.json({}, { status: 404 }));
    const clients = new AccountClients(store, fetchImpl);
    await (await clients.sessionFor(alice.userId).api()).getSubscription();
    await (await clients.sessionFor(bob.userId).api()).getSubscription();
    const bearers = calls
      .filter((call) => call.url.includes("/subscriptions"))
      .map((call) => call.authorization);
    assert.ok(bearers.includes("Bearer alice-access"));
    assert.ok(bearers.includes("Bearer bob-access"));
    await clients.sessionFor(alice.userId).logout();
    assert.equal(await store.load(alice.userId), undefined);
    assert.ok(await store.load(bob.userId));
  });
});

describe("stdio account", () => {
  it("signs in from env credentials once and does not store the password", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hf-stdio-"));
    const path = join(dir, "account.json");
    const { fetchImpl, calls } = recorded((call) => {
      if (call.url.includes("/gw/login")) {
        return Response.json({
          access_token: "stdio-access",
          refresh_token: "stdio-refresh",
          expires_in: 1800,
        });
      }
      return okAccount(call) ?? Response.json({}, { status: 404 });
    });
    const session = createStdioSession(
      {
        HELLOFRESH_ACCOUNT_PATH: path,
        HELLOFRESH_EMAIL: "ada@example.com",
        HELLOFRESH_PASSWORD: "stdio-password",
        HELLOFRESH_COUNTRY: "fr",
      },
      fetchImpl
    );
    const api = await session.api();
    assert.equal(api.email, "ada@example.com");
    const raw = await readFile(path, "utf8");
    assert.equal(raw.includes("stdio-password"), false);
    assert.equal(calls.filter((call) => call.url.includes("/gw/login")).length, 1);
    await session.api();
    assert.equal(calls.filter((call) => call.url.includes("/gw/login")).length, 1);
  });
});

function stored(accessToken: string, issuedAt: number, expiresIn: number): StoredAccount {
  return {
    userId: userIdFor("fr", "ada@example.com"),
    email: "ada@example.com",
    country: "fr",
    accessToken,
    refreshToken: "old-refresh",
    issuedAt,
    expiresIn,
    savedAt: new Date().toISOString(),
  };
}
