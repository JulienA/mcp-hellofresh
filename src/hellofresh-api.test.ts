import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it, mock } from "node:test";
import { AccountStore, userIdFor, type StoredAccount } from "./accounts.js";
import { createAccountLinker } from "./account-linker.js";
import {
  HelloFreshApi,
  HelloFreshApiError,
  RECIPE_DETAILS_TTL_MS,
  clearRecipeDetailsCache,
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
    assert.equal(menu.recipes[0]?.prepTime, null);
    assert.equal(menu.recipes[0]?.label, undefined);
    assert.deepEqual(menu.recipes[0]?.tags, []);
    assert.equal(updates.at(-1)?.accessToken, "new-access");
    assert.ok(calls.some((call) => call.url.includes("/gw/refresh")));
  });

  it("reads prep time and labels from the menu", async () => {
    const { fetchImpl } = recorded((call) => {
      if (call.url.includes("/my-deliveries/menu")) {
        return Response.json({
          week: WEEK,
          meals: [
            {
              index: 1,
              recipe: {
                id: "recipe-quick",
                name: "Poulet",
                headline: "et riz",
                prepTime: "PT25M",
                totalTime: "PT1H15M",
                label: { text: "Rapide", handle: "quick", displayLabel: true },
                tags: [
                  { name: "Rapide", type: "quick", displayLabel: true },
                  { name: "Veggie", type: "veggie", displayLabel: true },
                  { name: "pork-free", type: "pork-free", displayLabel: false },
                ],
              },
            },
            {
              index: 2,
              recipe: { id: "recipe-plain", name: "Soupe", headline: "du jour" },
            },
            {
              index: 3,
              recipe: {
                id: "recipe-long",
                name: "Boeuf",
                prepTime: "PT1H15M",
                label: { text: "Nouveau", displayLabel: false },
                tags: ["Famille", "famille"],
              },
            },
            {
              index: 4,
              recipe: { id: "recipe-number", name: "Riz", prepTime: "30" },
            },
            {
              index: 5,
              recipe: { id: "recipe-total", name: "Poisson", totalTime: 40 },
            },
          ],
        });
      }
      return okAccount(call) ?? Response.json({}, { status: 404 });
    });
    const api = new HelloFreshApi(stored("access", Math.floor(Date.now() / 1000), 1800), fetchImpl);
    const menu = await api.getMenu(0);
    const quick = menu.recipes.find((recipe) => recipe.id === "recipe-quick");
    const plain = menu.recipes.find((recipe) => recipe.id === "recipe-plain");
    const long = menu.recipes.find((recipe) => recipe.id === "recipe-long");
    const numeric = menu.recipes.find((recipe) => recipe.id === "recipe-number");
    const total = menu.recipes.find((recipe) => recipe.id === "recipe-total");
    assert.equal(quick?.prepTime, 25);
    assert.equal(quick?.label, "Rapide");
    assert.deepEqual(quick?.tags, ["Veggie"]);
    assert.equal(plain?.prepTime, null);
    assert.equal(plain?.label, undefined);
    assert.deepEqual(plain?.tags, []);
    assert.equal(long?.prepTime, 75);
    assert.equal(long?.label, undefined);
    assert.deepEqual(long?.tags, ["Famille"]);
    assert.equal(numeric?.prepTime, 30);
    assert.equal(total?.prepTime, 40);
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

  it("writes the requested quantity and keeps the plan portion size", async () => {
    const { fetchImpl, calls } = recorded((call) => okAccount(call) ?? Response.json({}, { status: 404 }));
    const api = new HelloFreshApi(stored("access", Math.floor(Date.now() / 1000), 1800), fetchImpl);
    const doubled = await api.selectMeals(WEEK, [{ recipeId: "recipe-9", quantity: 2 }]);
    const omitted = await api.selectMeals(WEEK, [{ recipeId: "recipe-9" }]);
    const puts = calls.filter((call) => call.method === "PUT");
    assert.equal(puts.length, 2);
    assert.match(puts[0].url, /\/gw\/v1\/carts\/2099-W01/);
    assert.match(puts[0].url, /customer=cust-1/);
    assert.match(puts[0].url, /product-sku=FR-CBT-2-2-0/);
    assert.match(puts[1].url, /product-sku=FR-CBT-3-2-0/);
    const doubledBody = JSON.parse(puts[0].body) as { meals: Array<{ index: number; quantity: number }> };
    const omittedBody = JSON.parse(puts[1].body) as { meals: Array<{ index: number; quantity: number }> };
    assert.deepEqual(doubledBody.meals, [{ index: 4, quantity: 2 }]);
    assert.deepEqual(omittedBody.meals, [{ index: 4, quantity: 1 }]);
    assert.equal(doubled.servingsPerMeal, 2);
    assert.equal(omitted.servingsPerMeal, 2);
    assert.deepEqual(doubled.meals, [{ index: 4, quantity: 2 }]);
  });

  it("caps a repeated recipe at 10 cartons", async () => {
    const { fetchImpl, calls } = recorded((call) => okAccount(call) ?? Response.json({}, { status: 404 }));
    const api = new HelloFreshApi(stored("access", Math.floor(Date.now() / 1000), 1800), fetchImpl);
    await api.selectMeals(WEEK, [
      { recipeId: "recipe-9", quantity: 6 },
      { recipeId: "recipe-9", quantity: 6 },
    ]);
    const puts = calls.filter((call) => call.method === "PUT");
    assert.equal(puts.length, 1);
    assert.match(puts[0].url, /product-sku=FR-CBT-10-2-0/);
    assert.deepEqual(JSON.parse(puts[0].body).meals, [{ index: 4, quantity: 10 }]);
    await assert.rejects(() => api.selectMeals(WEEK, [{ recipeId: "recipe-9", quantity: 11 }]), (error: unknown) => {
      assert.ok(error instanceof HelloFreshApiError);
      assert.match(error.message, /quantity must be a whole number from 1 to 10/);
      return true;
    });
    assert.equal(calls.filter((call) => call.method === "PUT").length, 1);
  });

  it("does not copy a one-portion week sku and merges a repeated recipe", async () => {
    const menu = {
      week: WEEK,
      meals: [
        { index: 1, recipe: { id: "recipe-a", name: "Poulet" } },
        { index: 2, recipe: { id: "recipe-b", name: "Soupe" } },
        { index: 3, recipe: { id: "recipe-c", name: "Tacos" } },
        { index: 4, recipe: { id: "recipe-d", name: "Riz" } },
      ],
    };
    const { fetchImpl, calls } = recorded((call) => {
      if (call.url.includes("/customers/me/deliveries")) {
        return Response.json({
          items: [
            {
              id: WEEK,
              deliveryDate: "2099-01-06T00:00:00+0000",
              cutoffDate: "2099-01-04T23:59:59+0000",
              status: "RUNNING",
              subscriptionId: "sub-1",
              product: { handle: "FR-CBT-3-1-0" },
            },
          ],
        });
      }
      if (call.url.includes("/my-deliveries/menu")) {
        return Response.json(menu);
      }
      return okAccount(call) ?? Response.json({}, { status: 404 });
    });
    const api = new HelloFreshApi(stored("access", Math.floor(Date.now() / 1000), 1800), fetchImpl);
    const four = await api.selectMeals(WEEK, [
      { recipeId: "recipe-a" },
      { recipeId: "recipe-b" },
      { recipeId: "recipe-a" },
      { recipeId: "recipe-c" },
      { recipeId: "recipe-d" },
    ]);
    const two = await api.selectMeals(WEEK, [
      { recipeId: "recipe-a" },
      { recipeId: "recipe-b" },
    ]);
    const puts = calls.filter((call) => call.method === "PUT");
    assert.equal(puts.length, 2);
    assert.match(puts[0].url, /product-sku=FR-CBT-5-2-0/);
    assert.equal(puts[0].url.includes("FR-CBT-3-1-0"), false);
    assert.match(puts[1].url, /product-sku=FR-CBT-2-2-0/);
    assert.deepEqual(JSON.parse(puts[0].body).meals, [
      { index: 1, quantity: 2 },
      { index: 2, quantity: 1 },
      { index: 3, quantity: 1 },
      { index: 4, quantity: 1 },
    ]);
    assert.deepEqual(JSON.parse(puts[1].body).meals, [
      { index: 1, quantity: 1 },
      { index: 2, quantity: 1 },
    ]);
    assert.equal(four.servingsPerMeal, 2);
    assert.equal(two.servingsPerMeal, 2);
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

describe("upcoming deliveries", () => {
  it("keeps the unscoped deliveries URL and returns selected meals for weeks still ahead", async () => {
    const { fetchImpl, calls } = recorded((call) => {
      if (call.url.includes("/customers/me/subscriptions")) {
        const body = subscriptionBody() as { items: Array<Record<string, unknown>> };
        body.items[0].locale = "en-US";
        return Response.json(body);
      }
      if (call.url.includes("/customers/me/deliveries")) {
        assert.equal(new URL(call.url).searchParams.has("rangeStart"), false);
        assert.equal(new URL(call.url).searchParams.has("rangeEnd"), false);
        assert.equal(new URL(call.url).searchParams.get("country"), "FR");
        assert.equal(new URL(call.url).searchParams.get("locale"), "fr-FR");
        return Response.json({
          items: [
            {
              id: "2026-W44",
              deliveryDate: "2026-10-24T12:00:00+0200",
              cutoffDate: "2026-10-20T23:59:59+0200",
              status: "DELIVERED",
              subscriptionId: 812405,
              product: { handle: "FR-CBU-3-2-0" },
            },
            {
              id: "2026-W45",
              deliveryDate: "2026-10-31T12:00:00+0100",
              cutoffDate: "2026-10-27T23:59:59+0100",
              status: "RUNNING",
              subscriptionId: 812405,
              product: { handle: "FR-CBU-6-2-0" },
            },
            {
              id: "2026-W46",
              deliveryDate: "2026-11-07T12:00:00+0100",
              cutoffDate: "2026-11-03T23:59:59+0100",
              status: "RUNNING",
              subscriptionId: 812405,
              product: { handle: "FR-CBU-6-2-0" },
            },
            {
              id: "2026-W47",
              deliveryDate: "2026-11-14T12:00:00+0100",
              cutoffDate: "2026-11-10T23:59:59+0100",
              status: "PAUSED",
              subscriptionId: 812405,
              product: { handle: "FR-CBU-3-2-0" },
            },
          ],
        });
      }
      if (call.url.includes("/my-deliveries/menu")) {
        const params = new URL(call.url).searchParams;
        const week = params.get("week");
        if (week === "2026-W45") {
          assert.equal(params.get("product-sku"), "FR-CBU-6-2-0");
          return Response.json({
            week: "2026-W45",
            meals: [
              { index: 1, selection: { quantity: 2 }, recipe: { id: "recipe-a", name: "Poulet" } },
              { index: 2, selection: { quantity: 0 }, recipe: { id: "recipe-b", name: "Soupe" } },
              { index: 3, selection: { quantity: 1 }, recipe: { id: "recipe-c", name: "Tacos" } },
              { index: 4, selection: { quantity: 0, oneOffQuantity: 3 }, recipe: { id: "recipe-d", name: "Riz" } },
            ],
          });
        }
        if (week === "2026-W46") {
          return Response.json({ message: "menu down" }, { status: 500 });
        }
        return Response.json({ week, meals: [] });
      }
      return okAccount(call) ?? Response.json({}, { status: 404 });
    });
    const api = new HelloFreshApi(stored("access", Math.floor(Date.now() / 1000), 1800), fetchImpl);
    const deliveries = await api.getDeliveries();
    assert.deepEqual(
      deliveries.map((week) => week.weekId),
      ["2026-W45", "2026-W46", "2026-W47"]
    );
    assert.equal(deliveries.some((week) => week.weekId === "2026-W44"), false);
    assert.equal(deliveries[0]?.servingsPerMeal, 2);
    assert.deepEqual(deliveries[0]?.meals, [
      { recipeId: "recipe-a", recipeName: "Poulet", quantity: 2 },
      { recipeId: "recipe-c", recipeName: "Tacos", quantity: 1 },
      { recipeId: "recipe-d", recipeName: "Riz", quantity: 3 },
    ]);
    assert.deepEqual(deliveries[1]?.meals, []);
    assert.equal(deliveries[2]?.status, "PAUSED");
    const subscription = await api.getSubscription();
    assert.equal(subscription.nextDeliveryDate, "2026-10-31T12:00:00+0100");
    const menu = await api.getMenu(0);
    assert.equal(menu.weekId, "2026-W45");
    assert.deepEqual(
      menu.recipes.map((recipe) => recipe.name),
      ["Poulet", "Soupe", "Tacos", "Riz"]
    );
    const deliveryCalls = calls.filter((call) => call.url.includes("/customers/me/deliveries"));
    assert.ok(deliveryCalls.length >= 1);
    assert.equal(deliveryCalls.every((call) => !call.url.includes("rangeStart")), true);
  });
});

const TINY_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const RESIZED_TACOS =
  "https://img.hellofresh.com/w_800,c_limit,f_jpg,q_auto,fl_lossy/hellofresh_s3/image/tacos.jpg";

describe("HelloFreshApi.getRecipeImage", () => {
  beforeEach(() => {
    clearRecipeDetailsCache();
  });

  function apiFor(handler: (call: Call) => Response | undefined) {
    const recordedFetch = recorded((call) => handler(call) ?? okAccount(call) ?? Response.json({}, { status: 404 }));
    const api = new HelloFreshApi(stored("access", Math.floor(Date.now() / 1000), 1800), recordedFetch.fetchImpl);
    return { api, calls: recordedFetch.calls };
  }

  it("downloads a resized JPEG for a relative image path", async () => {
    const { api, calls } = apiFor((call) => {
      if (call.url.includes("/recipes/recipes/")) {
        return Response.json({ id: "recipe-9", name: "Tacos", imagePath: "/image/tacos.jpg" });
      }
      if (call.url.startsWith("https://img.hellofresh.com/")) {
        assert.equal(call.authorization, "");
        assert.equal(call.url, RESIZED_TACOS);
        return new Response(TINY_JPEG, { headers: { "content-type": "image/jpeg" } });
      }
      return undefined;
    });
    const image = await api.getRecipeImage("recipe-9");
    assert.equal(image.recipeId, "recipe-9");
    assert.equal(image.name, "Tacos");
    assert.equal(image.url, RESIZED_TACOS);
    assert.equal(image.mimeType, "image/jpeg");
    assert.equal(image.data, TINY_JPEG.toString("base64"));
    const recipeCall = calls.find((call) => call.url.includes("/recipes/recipes/"));
    assert.equal(recipeCall?.authorization, "Bearer access");
  });

  it("keeps an absolute HelloFresh CDN link", async () => {
    const absolute = "https://img.hellofresh.com/hellofresh_s3/image/tacos.jpg";
    const { api } = apiFor((call) => {
      if (call.url.includes("/recipes/recipes/")) {
        return Response.json({ id: "recipe-9", name: "Tacos", imageLink: absolute, imagePath: "/image/other.jpg" });
      }
      if (call.url === absolute) {
        return new Response(TINY_JPEG, { headers: { "content-type": "image/jpeg; charset=binary" } });
      }
      return undefined;
    });
    const image = await api.getRecipeImage("recipe-9");
    assert.equal(image.url, absolute);
    assert.equal(image.mimeType, "image/jpeg");
    assert.equal(image.data, TINY_JPEG.toString("base64"));
  });

  it("errors when the recipe has no image", async () => {
    const { api, calls } = apiFor((call) => {
      if (call.url.includes("/recipes/recipes/")) {
        return Response.json({ id: "recipe-9", name: "Tacos" });
      }
      return undefined;
    });
    await assert.rejects(() => api.getRecipeImage("recipe-9"), (error: unknown) => {
      assert.ok(error instanceof HelloFreshApiError);
      assert.equal(error.code, "api");
      assert.match(error.message, /no image/);
      return true;
    });
    assert.equal(calls.some((call) => call.url.includes("img.hellofresh.com")), false);
  });

  it("rebuilds a broken CloudFront imageLink from its /image path", async () => {
    const cloudfront =
      "https://d3hvwccx09j84u.cloudfront.net/0,0/image/HF_Y26_R220_W14_FR_QFR53215-2_Main_high-1906ee87.jpg";
    const resized =
      "https://img.hellofresh.com/w_800,c_limit,f_jpg,q_auto,fl_lossy/hellofresh_s3/image/HF_Y26_R220_W14_FR_QFR53215-2_Main_high-1906ee87.jpg";
    const { api, calls } = apiFor((call) => {
      if (call.url.includes("/recipes/recipes/")) {
        return Response.json({
          id: "6a72e7f4ebec54be3cd9b330",
          name: "Poulet",
          imageLink: cloudfront,
          imagePath: "/image/HF_Y26_R220_W14_FR_QFR53215-2_Main_high-1906ee87.jpg",
        });
      }
      if (call.url === resized) {
        return new Response(TINY_JPEG, { headers: { "content-type": "image/jpeg" } });
      }
      return undefined;
    });
    const image = await api.getRecipeImage("6a72e7f4ebec54be3cd9b330");
    assert.equal(image.url, resized);
    assert.equal(image.data, TINY_JPEG.toString("base64"));
    assert.equal(calls.some((call) => call.url.includes("cloudfront.net")), false);
  });

  it("does not fetch an image hosted outside the HelloFresh CDN", async () => {
    const { api, calls } = apiFor((call) => {
      if (call.url.includes("/recipes/recipes/")) {
        return Response.json({ id: "recipe-9", imageLink: "https://evil.example/pic.jpg" });
      }
      return undefined;
    });
    await assert.rejects(() => api.getRecipeImage("recipe-9"), (error: unknown) => {
      assert.ok(error instanceof HelloFreshApiError);
      assert.match(error.message, /not on the HelloFresh CDN/);
      return true;
    });
    assert.equal(calls.some((call) => call.url.includes("evil.example")), false);
  });

  it("rejects a response that is not an image or is larger than 2 MB", async () => {
    const htmlApi = apiFor((call) => {
      if (call.url.includes("/recipes/recipes/")) {
        return Response.json({ id: "recipe-9", imagePath: "/image/tacos.jpg" });
      }
      if (call.url.startsWith("https://img.hellofresh.com/")) {
        return new Response("<html></html>", { headers: { "content-type": "text/html" } });
      }
      return undefined;
    }).api;
    await assert.rejects(() => htmlApi.getRecipeImage("recipe-9"), /did not return an image/);

    const oversized = Buffer.alloc(2 * 1024 * 1024 + 1);
    const bigApi = apiFor((call) => {
      if (call.url.includes("/recipes/recipes/")) {
        return Response.json({ id: "recipe-9", imagePath: "/image/tacos.jpg" });
      }
      if (call.url.startsWith("https://img.hellofresh.com/")) {
        return new Response(oversized, { headers: { "content-type": "image/jpeg" } });
      }
      return undefined;
    }).api;
    await assert.rejects(() => bigApi.getRecipeImage("recipe-9"), /larger than 2 MB/);
  });
});

const RECIPE_A = "6a72e7f4ebec54be3cd9b330";
const RECIPE_B = "6a72e7f4ebec54be3cd9b331";

describe("HelloFreshApi recipe details cache", () => {
  beforeEach(() => {
    clearRecipeDetailsCache();
  });

  function recipeCalls(calls: Call[]): Call[] {
    return calls.filter((call) => call.url.includes("/recipes/recipes/"));
  }

  function imageCalls(calls: Call[]): Call[] {
    return calls.filter((call) => call.url.startsWith("https://img.hellofresh.com/"));
  }

  function client(fetchImpl: FetchLike, country: string, email: string, token = "access"): HelloFreshApi {
    return new HelloFreshApi(stored(token, Math.floor(Date.now() / 1000), 24 * 60 * 60, country, email), fetchImpl);
  }

  it("shares one fetch between accounts in the same country", async () => {
    const { fetchImpl, calls } = recorded((call) => {
      if (call.url.includes(`/recipes/recipes/${RECIPE_A}`)) {
        return Response.json({ id: RECIPE_A, name: "Tacos", steps: ["sear"] });
      }
      return Response.json({ message: "missing" }, { status: 404 });
    });
    const first = client(fetchImpl, "fr", "ada@example.com", "token-a");
    const second = client(fetchImpl, "fr", "bea@example.com", "token-b");
    const left = await first.getRecipe(RECIPE_A);
    left.name = "changed";
    const right = await second.getRecipe(RECIPE_A);
    assert.equal(right.name, "Tacos");
    assert.deepEqual(right.steps, ["sear"]);
    assert.notEqual(left, right);
    assert.equal(recipeCalls(calls).length, 1);
    assert.equal(new URL(recipeCalls(calls)[0].url).searchParams.get("country"), "FR");
    assert.equal(new URL(recipeCalls(calls)[0].url).searchParams.get("locale"), "fr-FR");
  });

  it("fetches again for the same id in another country", async () => {
    const { fetchImpl, calls } = recorded((call) => {
      if (call.url.includes(`/recipes/recipes/${RECIPE_A}`)) {
        return Response.json({ id: RECIPE_A, name: call.origin.includes(".de") ? "Tacos DE" : "Tacos" });
      }
      return Response.json({ message: "missing" }, { status: 404 });
    });
    const france = client(fetchImpl, "fr", "ada@example.com");
    const germany = client(fetchImpl, "de", "ada@example.com", "token-de");
    assert.equal((await france.getRecipe(RECIPE_A)).name, "Tacos");
    assert.equal((await germany.getRecipe(RECIPE_A)).name, "Tacos DE");
    assert.equal(recipeCalls(calls).length, 2);
    assert.equal(recipeCalls(calls).some((call) => call.url.includes("hellofresh.de")), true);
    assert.equal(new URL(recipeCalls(calls)[1].url).searchParams.get("locale"), "de-DE");
  });

  it("reuses the cached recipe for images, including another account", async () => {
    const { fetchImpl, calls } = recorded((call) => {
      if (call.url.includes(`/recipes/recipes/${RECIPE_A}`)) {
        return Response.json({ id: RECIPE_A, name: "Tacos", imagePath: "/image/tacos.jpg" });
      }
      if (call.url === RESIZED_TACOS) {
        return new Response(TINY_JPEG, { headers: { "content-type": "image/jpeg" } });
      }
      return Response.json({ message: "missing" }, { status: 404 });
    });
    const first = client(fetchImpl, "fr", "ada@example.com");
    const second = client(fetchImpl, "fr", "bea@example.com");
    await first.getRecipe(RECIPE_A);
    const ownImage = await first.getRecipeImage(RECIPE_A);
    const sharedImage = await second.getRecipeImage(RECIPE_A);
    assert.equal(ownImage.url, RESIZED_TACOS);
    assert.equal(sharedImage.data, TINY_JPEG.toString("base64"));
    assert.equal(recipeCalls(calls).length, 1);
    assert.equal(imageCalls(calls).length, 2);
  });

  it("fetches each distinct recipe id", async () => {
    const { fetchImpl, calls } = recorded((call) => {
      if (call.url.includes("/recipes/recipes/")) {
        const id = new URL(call.url).pathname.split("/").pop();
        return Response.json({ id, name: id });
      }
      return Response.json({ message: "missing" }, { status: 404 });
    });
    const api = client(fetchImpl, "fr", "ada@example.com");
    assert.equal((await api.getRecipe(RECIPE_A)).id, RECIPE_A);
    assert.equal((await api.getRecipe(RECIPE_B)).id, RECIPE_B);
    assert.equal(recipeCalls(calls).length, 2);
  });

  it("coalesces concurrent loads of the same recipe", async () => {
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let fetches = 0;
    const fetchImpl: FetchLike = async (input) => {
      const url = String(input);
      if (url.includes(`/recipes/recipes/${RECIPE_A}`)) {
        fetches += 1;
        await gate;
        return Response.json({ id: RECIPE_A, name: "Tacos" });
      }
      return Response.json({ message: "missing" }, { status: 404 });
    };
    const first = client(fetchImpl, "fr", "ada@example.com", "token-a");
    const second = client(fetchImpl, "fr", "bea@example.com", "token-b");
    const pending = Promise.all([first.getRecipe(RECIPE_A), second.getRecipe(RECIPE_A)]);
    await new Promise<void>((resolve, reject) => {
      setImmediate(() => {
        try {
          assert.equal(fetches, 1);
          release();
          resolve();
        } catch (error) {
          release();
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
    const [left, right] = await pending;
    assert.equal(left.name, "Tacos");
    assert.equal(right.name, "Tacos");
    assert.notEqual(left, right);
    assert.equal(fetches, 1);
  });

  it("does not cache a failed recipe lookup", async () => {
    let attempts = 0;
    const { fetchImpl, calls } = recorded((call) => {
      if (call.url.includes(`/recipes/recipes/${RECIPE_A}`)) {
        attempts += 1;
        if (attempts === 1) {
          return Response.json({ message: "down" }, { status: 500 });
        }
        return Response.json({ id: RECIPE_A, name: "Tacos" });
      }
      return Response.json({ message: "missing" }, { status: 404 });
    });
    const api = client(fetchImpl, "fr", "ada@example.com");
    await assert.rejects(() => api.getRecipe(RECIPE_A), (error: unknown) => {
      assert.ok(error instanceof HelloFreshApiError);
      assert.equal(error.code, "api");
      return true;
    });
    assert.equal((await api.getRecipe(RECIPE_A)).name, "Tacos");
    assert.equal(recipeCalls(calls).length, 2);
  });

  it("refetches a recipe after the cache ttl", async () => {
    mock.timers.enable({ apis: ["Date"], now: Date.now() });
    try {
      let attempts = 0;
      const { fetchImpl, calls } = recorded((call) => {
        if (call.url.includes(`/recipes/recipes/${RECIPE_A}`)) {
          attempts += 1;
          return Response.json({ id: RECIPE_A, name: `Tacos ${attempts}` });
        }
        return Response.json({ message: "missing" }, { status: 404 });
      });
      const api = client(fetchImpl, "fr", "ada@example.com");
      assert.equal((await api.getRecipe(RECIPE_A)).name, "Tacos 1");
      mock.timers.tick(RECIPE_DETAILS_TTL_MS - 1);
      assert.equal((await api.getRecipe(RECIPE_A)).name, "Tacos 1");
      mock.timers.tick(1);
      assert.equal((await api.getRecipe(RECIPE_A)).name, "Tacos 2");
      assert.equal(recipeCalls(calls).length, 2);
    } finally {
      mock.timers.reset();
    }
  });
});

function stored(
  accessToken: string,
  issuedAt: number,
  expiresIn: number,
  country = "fr",
  email = "ada@example.com"
): StoredAccount {
  return {
    userId: userIdFor(country, email),
    email,
    country,
    accessToken,
    refreshToken: "old-refresh",
    issuedAt,
    expiresIn,
    savedAt: new Date().toISOString(),
  };
}
