import { LRUCache } from "lru-cache";
import { AsyncMutex } from "./auth.js";
import {
  emailFromClaims,
  findEmail,
  normalizeEmail,
  userIdFor,
  decodeJwtClaims,
  type ParsedAuthBlob,
  type StoredAccount,
} from "./accounts.js";
import { helloFreshCountry, type HelloFreshCountry } from "./countries.js";
import { log, logPath } from "./log.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type HelloFreshApiCode =
  | "invalid_credentials"
  | "bot_blocked"
  | "rate_limited"
  | "reconnect_required"
  | "missing_email"
  | "invalid_token"
  | "unsupported"
  | "api";

export class HelloFreshApiError extends Error {
  readonly code: HelloFreshApiCode;

  constructor(code: HelloFreshApiCode, message: string) {
    super(message);
    this.name = "HelloFreshApiError";
    this.code = code;
  }
}

export const RECONNECT_MESSAGE =
  "HelloFresh access expired. Disconnect the connector in Claude or ChatGPT and connect it again, then sign in on the authorize page. Do not send a password in chat.";

export const RATE_RECIPE_UNSUPPORTED =
  "rate_recipe is not available through the HelloFresh API this connector uses. Rate the recipe on the HelloFresh website.";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const RECIPE_IMAGE_CDN_PREFIX =
  "https://img.hellofresh.com/w_800,c_limit,f_jpg,q_auto,fl_lossy/hellofresh_s3";
const MAX_RECIPE_IMAGE_BYTES = 2 * 1024 * 1024;

/** Shared across accounts. Recipe JSON is catalog data for a country and locale, not a user. */
export const RECIPE_DETAILS_TTL_MS = 30 * 60 * 1000;
const RECIPE_DETAILS_CACHE_MAX = 256;
const MENU_RECIPE_CONCURRENCY = 4;

interface RecipeDetailsContext {
  load: () => Promise<Record<string, unknown>>;
}

const recipeDetailsCache = new LRUCache<string, Record<string, unknown>, RecipeDetailsContext>({
  max: RECIPE_DETAILS_CACHE_MAX,
  ttl: RECIPE_DETAILS_TTL_MS,
  // Date.now(), not performance.now(), so tests can expire entries with mock.timers.
  // ttlResolution 0 reads that clock on every lookup instead of caching it for 1ms.
  perf: { now: () => Date.now() },
  ttlResolution: 0,
  fetchMethod: async (_key, _stale, { context }) => {
    if (!context) {
      throw new HelloFreshApiError("api", "A recipe id is required.");
    }
    return structuredClone(await context.load());
  },
});

export function clearRecipeDetailsCache(): void {
  recipeDetailsCache.clear();
}

function recipeDetailsKey(country: HelloFreshCountry, recipeId: string): string {
  return `${country.apiCountry}\0${country.locale}\0${recipeId}`;
}

export interface RecipeSummary {
  id: string;
  name: string;
  description: string;
  imageUrl?: string;
  /** Minutes, or null when HelloFresh did not send a readable time. */
  prepTime: number | null;
  /** Card badge, such as "Rapide". Omitted when there is none. */
  label?: string;
  tags: string[];
  /** kcal per portion, or null when HelloFresh did not send one. */
  calories: number | null;
  /** Allergens in the recipe. Traces are listed separately. */
  allergens: string[];
  /** Allergens present only as traces. The generic traces banner is omitted. */
  allergenTraces: string[];
  index?: number;
}

interface MenuRecipeDraft {
  summary: RecipeSummary;
  caloriesFromMenu: boolean;
  allergensFromMenu: boolean;
}

export interface RecipeImage {
  recipeId: string;
  name?: string;
  url: string;
  mimeType: string;
  data: string;
}

/** Stable fields for one recipe card. The full HelloFresh payload stays in the tool text. */
export interface RecipeCard {
  id: string;
  name: string;
  description: string;
  imageUrl?: string;
  prepTime: number | null;
  label?: string;
  tags: string[];
  calories: number | null;
  allergens: string[];
  allergenTraces: string[];
  ingredients: string[];
  steps: string[];
}

export interface AccountStatus {
  authenticated: boolean;
  email: string | null;
  country: string | null;
  accessTokenValid: boolean;
  savedAt: string | null;
  reconnectRequired: boolean;
}

interface SubscriptionRecord {
  id: string;
  customerPlanId?: string;
  customerId?: string;
  locale?: string;
  preset?: string;
  postcode?: string;
  deliveryOption?: string;
  sku?: string;
  meals?: number;
  servings?: number;
  deliveryInterval?: number;
  status?: string;
  raw: Record<string, unknown>;
}

export interface SelectedMeal {
  recipeId: string;
  recipeName: string;
  /** How many times this recipe is in the box. Not the plan's portions per meal. */
  quantity: number;
}

export interface DeliveryWeek {
  weekId: string;
  deliveryDate?: string;
  cutoffDate?: string;
  status?: string;
  subscriptionId?: string;
  sku?: string;
  /** Portions per meal from the week SKU, or the subscription plan. */
  servingsPerMeal?: number | null;
  meals: SelectedMeal[];
}

interface WeekRecord extends DeliveryWeek {
  raw: Record<string, unknown>;
}

export class HelloFreshApi {
  private readonly mutex = new AsyncMutex();
  private account: StoredAccount;
  readonly country: HelloFreshCountry;

  private reloginTried = false;
  /** Set when HelloFresh rejects the refresh token and password relogin cannot replace it. */
  private refreshRejected = false;

  constructor(
    account: StoredAccount,
    private readonly fetchImpl: FetchLike,
    private readonly hooks: {
      onUpdate?: (account: StoredAccount) => Promise<void>;
      /** Stdio only. HTTP never supplies a password relogin. */
      relogin?: () => Promise<StoredAccount>;
    } = {}
  ) {
    const country = helloFreshCountry(account.country);
    if (!country) {
      throw new HelloFreshApiError("api", `Unknown HelloFresh country: ${account.country}`);
    }
    this.country = country;
    this.account = account;
  }

  get email(): string {
    return this.account.email;
  }

  static async login(input: {
    email: string;
    password: string;
    country: string;
    fetchImpl?: FetchLike;
  }): Promise<HelloFreshApi> {
    const country = requireCountry(input.country);
    const fetchImpl = input.fetchImpl ?? fetch;
    const now = Math.floor(Date.now() / 1000);
    const payload = await authPost(fetchImpl, country, "/gw/login", {
      username: input.email.trim(),
      password: input.password,
    });
    const account = accountFromAuthPayload(payload, country.code, normalizeEmail(input.email), now);
    const api = new HelloFreshApi(account, fetchImpl);
    try {
      await api.assertSubscriptions();
    } catch (error) {
      if (error instanceof HelloFreshApiError && error.code === "reconnect_required") {
        throw new HelloFreshApiError(
          "invalid_credentials",
          "HelloFresh did not accept these credentials."
        );
      }
      throw error;
    }
    const discovered = await api.discoverEmail();
    if (discovered) {
      api.account = { ...api.account, email: discovered, userId: userIdFor(country.code, discovered) };
    }
    return api;
  }

  static async fromPasted(input: {
    token: string;
    country: string;
    fetchImpl?: FetchLike;
    parsed?: ParsedAuthBlob;
  }): Promise<HelloFreshApi> {
    const country = requireCountry(input.country);
    const parsed = input.parsed;
    if (!parsed?.accessToken) {
      throw new HelloFreshApiError("invalid_token", "That apiV2Auth value could not be read.");
    }
    const fetchImpl = input.fetchImpl ?? fetch;
    const now = Math.floor(Date.now() / 1000);
    const claims = decodeJwtClaims(parsed.accessToken);
    const account: StoredAccount = {
      userId: "pending",
      email: emailFromClaims(claims) ?? "",
      country: country.code,
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken,
      issuedAt: parsed.issuedAt ?? now,
      expiresIn: parsed.expiresIn ?? 0,
      refreshExpiresIn: parsed.refreshExpiresIn,
      refreshIssuedAt: parsed.refreshIssuedAt,
      tokenType: parsed.tokenType,
      savedAt: new Date().toISOString(),
    };
    const api = new HelloFreshApi(account, fetchImpl);
    try {
      await api.assertSubscriptions();
    } catch (error) {
      if (error instanceof HelloFreshApiError && error.code === "reconnect_required") {
        throw new HelloFreshApiError("invalid_token", "HelloFresh rejected that apiV2Auth value.");
      }
      throw error;
    }
    const email = (await api.discoverEmail()) ?? (account.email || undefined);
    if (!email) {
      throw new HelloFreshApiError(
        "missing_email",
        "HelloFresh did not return an email for this account, so it cannot be linked."
      );
    }
    api.account = {
      ...api.account,
      email,
      userId: userIdFor(country.code, email),
      savedAt: new Date().toISOString(),
    };
    return api;
  }

  toStoredAccount(): StoredAccount {
    return { ...this.account, userId: userIdFor(this.account.country, this.account.email) };
  }

  status(): AccountStatus {
    return {
      authenticated: true,
      email: this.account.email,
      country: this.account.country,
      accessTokenValid: !this.refreshRejected && !this.accessExpiring(0),
      savedAt: this.account.savedAt,
      reconnectRequired: this.refreshRejected,
    };
  }

  async getMenu(weekOffset = 0): Promise<{ weekId: string; recipes: RecipeSummary[] }> {
    return this.mutex.runExclusive(async () => {
      const { subscription, weeks } = await this.loadWeeks();
      const upcoming = upcomingWeeks(weeks);
      const week = upcoming[weekOffset];
      if (!week) {
        throw new HelloFreshApiError("api", `No HelloFresh menu week at offset ${weekOffset}.`);
      }
      const recipes = await this.recipesForWeek(subscription, week, true);
      return { weekId: week.weekId, recipes };
    });
  }

  async getRecipe(recipeId: string): Promise<Record<string, unknown>> {
    return this.mutex.runExclusive(() => this.loadRecipe(recipeId));
  }

  async getRecipeImage(recipeId: string): Promise<RecipeImage> {
    return this.mutex.runExclusive(async () => {
      const recipe = await this.loadRecipe(recipeId);
      const url = recipeImageUrl(recipe);
      const image = await this.fetchPublicImage(url);
      return {
        recipeId: stringField(recipe, ["id", "recipeId"]) ?? recipeId.trim(),
        name: stringField(recipe, ["name", "title"]),
        url,
        mimeType: image.mimeType,
        data: image.data,
      };
    });
  }

  /** Card fields for a recipe payload already loaded from HelloFresh. */
  recipeCard(recipe: Record<string, unknown>): RecipeCard {
    const french = frenchTagLabels(this.country.code);
    const nutrition = nutritionFromRecipe(recipe);
    const label = recipeLabel(recipe);
    const imageUrl = imageUrlFromRecipe(recipe);
    return {
      id: stringField(recipe, ["id", "recipeId"]) ?? "",
      name: stringField(recipe, ["name", "title"]) ?? "",
      description: plainText(stringField(recipe, ["headline", "description"]) ?? ""),
      ...(imageUrl ? { imageUrl } : {}),
      prepTime: prepMinutes(recipe),
      ...(label ? { label } : {}),
      tags: recipeTags(recipe, label, french),
      calories: nutrition.calories,
      allergens: nutrition.allergens ?? [],
      allergenTraces: nutrition.allergenTraces ?? [],
      ingredients: ingredientLines(recipe),
      steps: stepLines(recipe),
    };
  }

  private async loadRecipe(recipeId: string): Promise<Record<string, unknown>> {
    const bare = recipeId.split("-", 1)[0]?.trim();
    if (!bare) {
      throw new HelloFreshApiError("api", "A recipe id is required.");
    }
    const key = recipeDetailsKey(this.country, bare);
    const payload = await recipeDetailsCache.fetch(key, {
      context: { load: () => this.fetchRecipe(bare) },
    });
    if (!payload) {
      throw new HelloFreshApiError("api", "HelloFresh did not return this recipe.");
    }
    return structuredClone(payload);
  }

  private async fetchRecipe(bare: string): Promise<Record<string, unknown>> {
    const payload = await this.getJson(`/gw/recipes/recipes/${encodeURIComponent(bare)}`, {
      country: this.country.apiCountry,
      locale: this.country.locale,
    });
    return payload && typeof payload === "object" ? (payload as Record<string, unknown>) : { id: bare };
  }

  private async fetchPublicImage(url: string): Promise<{ mimeType: string; data: string }> {
    const response = await loggedFetch(
      this.fetchImpl,
      url,
      {
        method: "GET",
        headers: {
          Accept: "image/jpeg,image/*",
          "User-Agent": USER_AGENT,
        },
      },
      { country: this.country.code, userId: this.account.userId }
    );
    if (response.url && !helloFreshCdnUrl(response.url)) {
      throw new HelloFreshApiError("api", "This recipe image is not on the HelloFresh CDN.");
    }
    if (!response.ok) {
      throw new HelloFreshApiError("api", `HelloFresh image request returned HTTP ${response.status}.`);
    }
    const mimeType = imageMimeType(response.headers.get("content-type"));
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_RECIPE_IMAGE_BYTES) {
      throw new HelloFreshApiError("api", "The recipe image is larger than 2 MB.");
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_RECIPE_IMAGE_BYTES) {
      throw new HelloFreshApiError(
        "api",
        bytes.byteLength === 0
          ? "HelloFresh did not return an image."
          : "The recipe image is larger than 2 MB."
      );
    }
    return { mimeType, data: bytes.toString("base64") };
  }

  async selectMeals(
    weekId: string,
    meals: Array<{ recipeId: string; quantity?: number }>
  ): Promise<Record<string, unknown>> {
    return this.mutex.runExclusive(async () => {
      const { subscription, weeks } = await this.loadWeeks();
      const week = weeks.find((item) => item.weekId === weekId);
      if (!week) {
        throw new HelloFreshApiError("api", `Week ${weekId} was not found on this account.`);
      }
      const recipes = await this.recipesForWeek(subscription, week);
      // quantity is how many times the recipe is in the box. Portions stay on the plan.
      const selected: Array<{ index: number; quantity: number }> = [];
      for (const meal of meals) {
        const recipe = recipes.find((item) => item.id === meal.recipeId);
        if (!recipe || recipe.index === undefined) {
          throw new HelloFreshApiError(
            "api",
            `Recipe ${meal.recipeId} is not on the menu for ${weekId}.`
          );
        }
        const quantity = cartQuantity(meal.quantity);
        const existing = selected.find((item) => item.index === recipe.index);
        if (existing) {
          existing.quantity = Math.min(MAX_CART_QUANTITY, existing.quantity + quantity);
          continue;
        }
        selected.push({ index: recipe.index, quantity });
      }
      const portions = planPortions(subscription);
      const totalQuantity = selected.reduce((sum, meal) => sum + meal.quantity, 0);
      const mealCount = cartMealCount(subscription, totalQuantity);
      const customerId = subscription.customerId;
      const sku = await this.cartProductSku(subscription, mealCount, portions, week.sku);
      const cutoff = formatCutoff(week.cutoffDate);
      if (!customerId || !sku || !cutoff || !subscription.id) {
        throw new HelloFreshApiError(
          "api",
          `Week ${weekId} is missing the cart details HelloFresh needs to save a selection.`
        );
      }
      const params = new URLSearchParams({
        customer: customerId,
        cutoff_time: cutoff,
        ignore_addons: "false",
        preference: subscription.preset ?? "",
        "product-sku": sku,
        subscription: subscription.id,
        update_quantity: "true",
        week: weekId,
      });
      const body = await this.request("PUT", `/gw/v1/carts/${encodeURIComponent(weekId)}?${params}`, {
        extras: [],
        meals: selected,
      }, { "x-requested-by": "shopping-experience-web" });
      return { weekId, servingsPerMeal: portions ?? null, meals: selected, result: body ?? { ok: true } };
    });
  }

  async skipWeek(weekId: string): Promise<Record<string, unknown>> {
    return this.mutex.runExclusive(async () => {
      const { weeks } = await this.loadWeeks();
      const week = requireWeek(weeks, weekId);
      await this.patchDeliveryStatus(week, "PAUSED");
      return { weekId, status: "PAUSED" };
    });
  }

  async getDeliveries(): Promise<DeliveryWeek[]> {
    return this.mutex.runExclusive(async () => {
      const { subscription, weeks } = await this.loadWeeks();
      const deliveries: DeliveryWeek[] = [];
      for (const week of scheduleWeeks(weeks)) {
        deliveries.push({
          weekId: week.weekId,
          deliveryDate: week.deliveryDate,
          cutoffDate: week.cutoffDate,
          status: week.status,
          subscriptionId: week.subscriptionId,
          sku: week.sku,
          servingsPerMeal: weekPortions(subscription, week.sku) ?? null,
          meals: await this.selectedMealsForWeek(subscription, week),
        });
      }
      return deliveries;
    });
  }

  async modifyDelivery(weekId: string, newDate: string): Promise<Record<string, unknown>> {
    return this.mutex.runExclusive(async () => {
      const { subscription, weeks } = await this.loadWeeks();
      const week = requireWeek(weeks, weekId);
      const options = await this.deliveryOptions(subscription);
      const match = options.find((option) => option.date?.startsWith(newDate));
      if (!match) {
        throw new HelloFreshApiError(
          "api",
          `HelloFresh has no delivery option on ${newDate} for this plan.`
        );
      }
      await this.request(
        "POST",
        `/gw/api/subscriptions/${encodeURIComponent(week.subscriptionId || subscription.id)}/oneoff${this.query()}`,
        {
          id: week.subscriptionId || subscription.id,
          delivery_option: match.handle,
          week: weekId,
          source: "reschedule-delivery-feature",
        }
      );
      return { weekId, deliveryOption: match.handle, date: match.date ?? newDate };
    });
  }

  async getPreferences(): Promise<Record<string, unknown>> {
    return this.mutex.runExclusive(async () => {
      const profile = await this.getJson("/gw/profile-service/v2/customers/me/profile", this.profileParams());
      return preferencesFromProfile(profile);
    });
  }

  async updatePreferences(changes: {
    vegetarian?: boolean;
    familyFriendly?: boolean;
    dietaryPreferences?: string[];
    allergens?: string[];
    cuisinePreferences?: string[];
  }): Promise<Record<string, unknown>> {
    return this.mutex.runExclusive(async () => {
      const current = await this.getJson("/gw/profile-service/v2/customers/me/profile", this.profileParams());
      const taste =
        current && typeof current === "object" && "taste" in current && typeof current.taste === "object"
          ? { ...(current.taste as Record<string, unknown>) }
          : {};
      if (changes.dietaryPreferences) {
        taste.dietaryPreferences = changes.dietaryPreferences;
      }
      if (changes.allergens) {
        taste.exclusions = changes.allergens;
      }
      if (changes.cuisinePreferences) {
        taste.cuisines = changes.cuisinePreferences;
      }
      if (changes.vegetarian !== undefined) {
        taste.vegetarian = changes.vegetarian;
      }
      if (changes.familyFriendly !== undefined) {
        taste.familyFriendly = changes.familyFriendly;
      }
      const updated = await this.request(
        "PATCH",
        `/gw/profile-service/v2/customers/me/profile${this.query(this.profileParams("food-profile"))}`,
        { taste }
      );
      return preferencesFromProfile(updated ?? { taste });
    });
  }

  async getSubscription(): Promise<Record<string, unknown>> {
    return this.mutex.runExclusive(async () => {
      const { subscription, weeks } = await this.loadWeeks();
      const next = upcomingWeeks(weeks)[0];
      const size = skuSize(subscription.sku);
      return {
        planId: subscription.customerPlanId ?? subscription.id,
        mealsPerWeek: subscription.meals ?? size.meals ?? 0,
        servingsPerMeal: subscription.servings ?? size.servings ?? 0,
        frequency: subscription.deliveryInterval === 2 ? "biweekly" : "weekly",
        pricePerServing: 0,
        nextDeliveryDate: next?.deliveryDate ?? "",
        status: subscription.status ?? "active",
        sku: subscription.sku ?? null,
      };
    });
  }

  async modifySubscription(changes: {
    mealsPerWeek?: number;
    servingsPerMeal?: number;
    frequency?: "weekly" | "biweekly";
  }): Promise<Record<string, unknown>> {
    return this.mutex.runExclusive(async () => {
      const { subscription } = await this.loadWeeks();
      const size = skuSize(subscription.sku);
      const meals = changes.mealsPerWeek ?? subscription.meals ?? size.meals;
      const servings = changes.servingsPerMeal ?? subscription.servings ?? size.servings;
      if (!subscription.customerPlanId || !meals || !servings) {
        throw new HelloFreshApiError("api", "This subscription does not expose a plan that can be changed.");
      }
      const handle =
        (await this.matchingProductHandle(subscription, meals, servings)) ||
        resizePlanSku(subscription.sku || "", meals, servings);
      if (!handle) {
        throw new HelloFreshApiError("api", "HelloFresh did not return a product handle for that box size.");
      }
      await this.request(
        "PATCH",
        `/gw/api/plans/${encodeURIComponent(subscription.customerPlanId)}${this.query()}`,
        { productHandle: handle }
      );
      return {
        productHandle: handle,
        mealsPerWeek: meals,
        servingsPerMeal: servings,
        frequencyApplied: false,
        frequencyNote: changes.frequency
          ? "Delivery frequency is unchanged. HelloFresh changes that separately from the box size."
          : undefined,
      };
    });
  }

  async getPastOrders(limit: number): Promise<Array<Record<string, unknown>>> {
    return this.mutex.runExclusive(async () => {
      const subscription = await this.primarySubscription();
      if (!subscription.id) {
        throw new HelloFreshApiError("api", "HelloFresh did not return a subscription id.");
      }
      const payload = await this.getJson("/gw/my-deliveries/past-deliveries", {
        country: this.country.apiCountry,
        locale: this.country.locale,
        subscription: subscription.id,
      });
      const weeks = asList(payload, ["weeks", "items", "data"])
        .map(asRecord)
        .filter((item): item is Record<string, unknown> => Boolean(item));
      return weeks.slice(0, limit).map((week) => ({
        orderId: stringField(week, ["id", "week", "weekId"]) ?? "",
        deliveryDate: stringField(week, ["deliveryDate", "delivery_date"]) ?? "",
        status: stringField(week, ["status", "state"]) ?? "",
        meals: [],
        totalPrice: 0,
      }));
    });
  }

  private async assertSubscriptions(): Promise<void> {
    const payload = await this.getJson("/gw/api/customers/me/subscriptions");
    const items = asList(payload, ["items"]);
    if (items.length === 0) {
      throw new HelloFreshApiError("invalid_token", "HelloFresh returned no subscription for this account.");
    }
  }

  private async discoverEmail(): Promise<string | undefined> {
    try {
      const info = await this.getJson("/gw/api/customers/me/info");
      return findEmail(info);
    } catch {
      return undefined;
    }
  }

  private async loadWeeks(): Promise<{ subscription: SubscriptionRecord; weeks: WeekRecord[] }> {
    const subscription = await this.primarySubscription();
    const payload = await this.getJson("/gw/api/customers/me/deliveries", {
      country: this.country.apiCountry,
      locale: this.country.locale,
    });
    const weeks = asList(payload, ["items", "deliveries", "weeks", "data"])
      .map((item) => weekFromRaw(item, subscription.id))
      .filter((item): item is WeekRecord => Boolean(item));
    return { subscription, weeks };
  }

  private async primarySubscription(): Promise<SubscriptionRecord> {
    const payload = await this.getJson("/gw/api/customers/me/subscriptions");
    const first = asList(payload, ["items"]).map(asRecord).find((item) => item);
    if (!first) {
      throw new HelloFreshApiError("reconnect_required", RECONNECT_MESSAGE);
    }
    return subscriptionFromRaw(first);
  }

  private async selectedMealsForWeek(subscription: SubscriptionRecord, week: WeekRecord): Promise<SelectedMeal[]> {
    const embedded = selectedMealsFromPayload(week.raw);
    const params = menuParams(subscription, week);
    if (!params) {
      return embedded;
    }
    try {
      const payload = await this.getJson("/gw/my-deliveries/menu", params);
      if (payload && typeof payload === "object" && "week" in payload && payload.week && payload.week !== week.weekId) {
        return embedded;
      }
      const fromMenu = selectedMealsFromPayload(payload);
      return fromMenu.length > 0 ? fromMenu : embedded;
    } catch {
      return embedded;
    }
  }

  private async recipesForWeek(
    subscription: SubscriptionRecord,
    week: WeekRecord,
    withNutrition = false
  ): Promise<RecipeSummary[]> {
    const french = frenchTagLabels(this.country.code);
    const embedded = recipesFromPayload(week.raw, french);
    const params = menuParams(subscription, week);
    let drafts = embedded;
    if (params) {
      try {
        const payload = await this.getJson("/gw/my-deliveries/menu", params);
        const wrongWeek =
          payload && typeof payload === "object" && "week" in payload && payload.week && payload.week !== week.weekId;
        if (!wrongWeek) {
          const fromMenu = recipesFromPayload(payload, french);
          if (fromMenu.length > 0) {
            drafts = fromMenu;
          }
        }
      } catch (error) {
        if (embedded.length === 0) {
          throw error;
        }
      }
    }
    if (withNutrition) {
      await this.enrichMenuNutrition(drafts);
    }
    return drafts.map((draft) => draft.summary);
  }

  private async enrichMenuNutrition(drafts: MenuRecipeDraft[]): Promise<void> {
    const queue = drafts.filter((draft) => !draft.caloriesFromMenu || !draft.allergensFromMenu);
    if (queue.length === 0) {
      return;
    }
    let cursor = 0;
    let stopped = false;
    const worker = async (): Promise<void> => {
      while (!stopped) {
        const index = cursor;
        cursor += 1;
        if (index >= queue.length) {
          return;
        }
        const draft = queue[index];
        try {
          const details = await this.loadRecipe(draft.summary.id);
          const nutrition = nutritionFromRecipe(details);
          if (!draft.caloriesFromMenu && nutrition.calories !== null) {
            draft.summary.calories = nutrition.calories;
          }
          if (!draft.allergensFromMenu && nutrition.allergens) {
            draft.summary.allergens = nutrition.allergens;
            draft.summary.allergenTraces = nutrition.allergenTraces ?? [];
          }
        } catch (error) {
          if (error instanceof HelloFreshApiError && error.code === "rate_limited") {
            stopped = true;
          }
        }
      }
    };
    const workers = Math.min(MENU_RECIPE_CONCURRENCY, queue.length);
    await Promise.all(Array.from({ length: workers }, () => worker()));
  }

  private async patchDeliveryStatus(week: WeekRecord, status: string): Promise<void> {
    if (!week.subscriptionId || !week.deliveryDate) {
      throw new HelloFreshApiError("api", `Week ${week.weekId} cannot be skipped without a delivery date.`);
    }
    const delivery: Record<string, unknown> = {
      deliveryDate: week.deliveryDate,
      status,
      subscriptionId: week.subscriptionId,
      id: week.weekId,
    };
    if (week.cutoffDate) {
      delivery.cutoffDate = week.cutoffDate;
    }
    await this.request(
      "PATCH",
      `/gw/api/subscriptions/${encodeURIComponent(week.subscriptionId)}/delivery_dates/${encodeURIComponent(week.weekId)}${this.query()}`,
      { delivery }
    );
  }

  private async deliveryOptions(
    subscription: SubscriptionRecord
  ): Promise<Array<{ handle: string; date?: string }>> {
    const family = nestedString(subscription.raw, ["productType", "family", "handle"]) || nestedString(subscription.raw, ["family"]);
    if (!family || !subscription.postcode) {
      return [];
    }
    const payload = await this.getJson("/gw/api/delivery_dates_options", {
      country: this.country.apiCountry,
      locale: subscription.locale || this.country.locale,
      family,
      numDeliveries: "7",
      zip: subscription.postcode,
      customerPriority: "active_subscription",
      customerJourney: "account_setting",
    });
    const options: Array<{ handle: string; date?: string }> = [];
    for (const item of asList(payload, ["items"])) {
      const record = asRecord(item);
      if (!record) {
        continue;
      }
      const date = stringField(record, ["deliveryDate", "delivery_date", "date"]);
      for (const rawOption of asList(record, ["deliveryOptions", "delivery_options"])) {
        const option = asRecord(rawOption);
        const handle = option ? stringField(option, ["handle", "id"]) : undefined;
        if (handle) {
          options.push({
            handle,
            date: (option && stringField(option, ["deliveryDate", "date"])) || date,
          });
        }
      }
    }
    return options;
  }

  private async cartProductSku(
    subscription: SubscriptionRecord,
    mealCount: number,
    portions: number | undefined,
    weekSku: string | undefined
  ): Promise<string> {
    if (portions && mealCount >= 2) {
      const handle =
        (await this.matchingProductHandle(subscription, mealCount, portions)) ||
        resizePlanSku(subscription.sku || "", mealCount, portions);
      if (handle) {
        return handle;
      }
    }
    return subscription.sku || weekSku || "";
  }

  private async matchingProductHandle(
    subscription: SubscriptionRecord,
    meals: number,
    servings: number
  ): Promise<string | undefined> {
    try {
      const payload = await this.getJson(
        `/gw/api/subscriptions/${encodeURIComponent(subscription.id)}/product_options`,
        { country: this.country.apiCountry, locale: subscription.locale || this.country.locale }
      );
      for (const item of asList(payload, ["items", "products", "options"])) {
        const record = asRecord(item);
        if (!record) {
          continue;
        }
        const handle = stringField(record, ["handle", "sku"]);
        const size = skuSize(handle);
        const itemMeals = numberField(record, ["meals"]) ?? size.meals;
        const itemServings = numberField(record, ["servings", "size"]) ?? size.servings;
        if (handle && itemMeals === meals && itemServings === servings) {
          return handle;
        }
      }
    } catch {
      return undefined;
    }
    return undefined;
  }

  private query(params: Record<string, string> = {}): string {
    const search = new URLSearchParams({
      country: this.country.apiCountry,
      locale: this.country.locale,
      ...params,
    });
    return `?${search}`;
  }

  private profileParams(source?: string): Record<string, string> {
    return {
      brand: "BRAND_HELLOFRESH",
      exclusion: "v2",
      regionCode: this.country.apiCountry,
      ...(source ? { source } : {}),
    };
  }

  private accessExpiring(skewSeconds: number): boolean {
    return Math.floor(Date.now() / 1000) + skewSeconds >= this.account.issuedAt + this.account.expiresIn;
  }

  private async getJson(path: string, params?: Record<string, string>): Promise<unknown> {
    const search = params ? `?${new URLSearchParams(params)}` : this.query();
    const url = path.includes("?") ? path : `${path}${search}`;
    return this.request("GET", url);
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
    retried = false
  ): Promise<unknown> {
    if (this.refreshRejected) {
      throw new HelloFreshApiError("reconnect_required", RECONNECT_MESSAGE);
    }
    if (this.accessExpiring(60) && this.account.refreshToken) {
      await this.refresh();
    }
    const response = await loggedFetch(
      this.fetchImpl,
      `${this.country.baseUrl}${path}`,
      {
        method,
        headers: {
          Accept: "application/json, text/plain, */*",
          Authorization: `Bearer ${this.account.accessToken}`,
          Origin: this.country.baseUrl,
          Referer: `${this.country.baseUrl}/my-account`,
          "User-Agent": USER_AGENT,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...extraHeaders,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      },
      { country: this.country.code, userId: this.account.userId, retried }
    );
    if (response.status === 401 && !retried && this.account.refreshToken) {
      await this.refresh();
      return this.request(method, path, body, extraHeaders, true);
    }
    if (response.status === 401) {
      throw new HelloFreshApiError("reconnect_required", RECONNECT_MESSAGE);
    }
    return readApiResponse(response, "HelloFresh request failed", "api");
  }

  private async refresh(): Promise<void> {
    if (this.refreshRejected) {
      throw new HelloFreshApiError("reconnect_required", RECONNECT_MESSAGE);
    }
    if (!this.account.refreshToken) {
      await this.tryRelogin();
      return;
    }
    const response = await loggedFetch(
      this.fetchImpl,
      `${this.country.baseUrl}/gw/refresh${this.query()}`,
      {
        method: "POST",
        headers: {
          Accept: "*/*",
          "Content-Type": "text/plain;charset=UTF-8",
          Origin: this.country.baseUrl,
          Referer: `${this.country.baseUrl}/login`,
          "User-Agent": USER_AGENT,
        },
        body: JSON.stringify({ refresh_token: this.account.refreshToken }),
      },
      { country: this.country.code, userId: this.account.userId }
    );
    let payload: unknown;
    try {
      payload = await readApiResponse(response, RECONNECT_MESSAGE, "reconnect_required");
    } catch (error) {
      if (error instanceof HelloFreshApiError && error.code !== "bot_blocked" && error.code !== "rate_limited") {
        await this.tryRelogin();
        return;
      }
      throw error;
    }
    const now = Math.floor(Date.now() / 1000);
    const next = accountFromAuthPayload(payload, this.account.country, this.account.email, now);
    this.refreshRejected = false;
    this.account = {
      ...this.account,
      accessToken: next.accessToken,
      refreshToken: next.refreshToken ?? this.account.refreshToken,
      issuedAt: next.issuedAt,
      expiresIn: next.expiresIn,
      refreshExpiresIn: next.refreshExpiresIn ?? this.account.refreshExpiresIn,
      refreshIssuedAt: next.refreshToken ? next.refreshIssuedAt : this.account.refreshIssuedAt,
      tokenType: next.tokenType ?? this.account.tokenType,
      savedAt: next.savedAt,
    };
    await this.hooks.onUpdate?.(this.toStoredAccount());
  }

  private async tryRelogin(): Promise<void> {
    if (!this.hooks.relogin || this.reloginTried) {
      this.refreshRejected = true;
      throw new HelloFreshApiError("reconnect_required", RECONNECT_MESSAGE);
    }
    this.reloginTried = true;
    try {
      this.account = await this.hooks.relogin();
    } catch (error) {
      if (!(error instanceof HelloFreshApiError) || (error.code !== "bot_blocked" && error.code !== "rate_limited")) {
        this.refreshRejected = true;
      }
      throw error;
    }
    this.refreshRejected = false;
    await this.hooks.onUpdate?.(this.toStoredAccount());
  }
}

export function accountFromAuthPayload(
  payload: unknown,
  country: string,
  email: string,
  now: number
): StoredAccount {
  const record = asRecord(payload);
  const accessToken = record ? stringField(record, ["access_token", "accessToken"]) : undefined;
  if (!accessToken) {
    throw new HelloFreshApiError("api", "HelloFresh did not return an access token.");
  }
  const refreshToken = record ? stringField(record, ["refresh_token", "refreshToken"]) : undefined;
  const expiresIn = (record && numberField(record, ["expires_in", "expiresIn"])) ?? 1800;
  const refreshExpiresIn = record ? numberField(record, ["refresh_expires_in", "refreshExpiresIn"]) : undefined;
  return {
    userId: userIdFor(country, email),
    email: normalizeEmail(email),
    country: helloFreshCountry(country)?.code ?? country,
    accessToken,
    refreshToken,
    issuedAt: now,
    expiresIn,
    refreshExpiresIn,
    refreshIssuedAt: refreshToken ? now : undefined,
    tokenType: record ? stringField(record, ["token_type", "tokenType"]) : undefined,
    savedAt: new Date(now * 1000).toISOString(),
  };
}

async function loggedFetch(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit | undefined,
  extra: { country?: string; userId?: string; retried?: boolean }
): Promise<Response> {
  const started = Date.now();
  const method = (init?.method ?? "GET").toUpperCase();
  const path = logPath(url);
  try {
    const response = await fetchImpl(url, init);
    const fields = {
      method,
      path,
      status: response.status,
      durationMs: Date.now() - started,
      country: extra.country,
      userId: extra.userId,
      retried: extra.retried || undefined,
    };
    if (response.status >= 500 || response.status === 429) {
      log.warn("hellofresh.request", fields);
    } else {
      log.info("hellofresh.request", fields);
    }
    return response;
  } catch (error) {
    log.warn("hellofresh.request", {
      method,
      path,
      durationMs: Date.now() - started,
      country: extra.country,
      userId: extra.userId,
      code: "network",
    });
    throw error;
  }
}

async function authPost(
  fetchImpl: FetchLike,
  country: HelloFreshCountry,
  path: string,
  body: Record<string, string>
): Promise<unknown> {
  const params = new URLSearchParams({ country: country.apiCountry, locale: country.locale });
  let response: Response;
  try {
    response = await loggedFetch(
      fetchImpl,
      `${country.baseUrl}${path}?${params}`,
      {
        method: "POST",
        headers: {
          Accept: "application/json, text/plain, */*",
          "Content-Type": "application/json",
          Origin: country.baseUrl,
          Referer: `${country.baseUrl}/login`,
          "User-Agent": USER_AGENT,
        },
        body: JSON.stringify(body),
      },
      { country: country.code }
    );
  } catch {
    throw new HelloFreshApiError("api", "HelloFresh could not be reached.");
  }
  return readApiResponse(response, "HelloFresh did not accept these credentials.", "invalid_credentials");
}

async function readApiResponse(
  response: Response,
  fallback: string,
  failure: HelloFreshApiCode
): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text();
  if (looksBlocked(response.status, contentType, text)) {
    throw new HelloFreshApiError(
      "bot_blocked",
      "HelloFresh blocked the request before it reached the account. This is not a wrong password."
    );
  }
  if (response.status === 429) {
    throw new HelloFreshApiError("rate_limited", "HelloFresh temporarily locked sign-in. Wait and try again.");
  }
  if (response.status === 400 || response.status === 401 || response.status === 403) {
    if (failure === "invalid_credentials" && socialSignInRequired(text)) {
      throw new HelloFreshApiError(
        "invalid_credentials",
        "This HelloFresh account signs in with Google, Apple, or Facebook. Sign in on the HelloFresh website, then paste apiV2Auth."
      );
    }
    throw new HelloFreshApiError(failure, fallback);
  }
  if (response.status >= 400) {
    throw new HelloFreshApiError("api", `HelloFresh returned HTTP ${response.status}.`);
  }
  if (!text.trim()) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function socialSignInRequired(body: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return false;
  }
  const record = asRecord(parsed);
  if (!record) {
    return false;
  }
  const hint = [
    record.error,
    record.error_description,
    record.message,
    record.code,
    record.reason,
  ]
    .filter((item) => typeof item === "string")
    .join(" ")
    .toLowerCase();
  return /google|apple|facebook|social/.test(hint);
}

function looksBlocked(status: number, contentType: string, body: string): boolean {
  if (contentType.includes("text/html") && status >= 400) {
    return true;
  }
  const sample = body.slice(0, 400).toLowerCase();
  return status === 403 && (sample.includes("cloudflare") || sample.includes("just a moment") || sample.includes("<html"));
}

function requireCountry(code: string): HelloFreshCountry {
  const country = helloFreshCountry(code);
  if (!country) {
    throw new HelloFreshApiError("api", "Choose a HelloFresh country.");
  }
  return country;
}

const TERMINAL_DELIVERY_STATUSES = new Set(["DELIVERED", "DONATED", "CANCELLED"]);

function scheduleWeeks(weeks: WeekRecord[]): WeekRecord[] {
  return [...weeks]
    .filter((week) => !TERMINAL_DELIVERY_STATUSES.has(week.status?.toUpperCase() ?? ""))
    .sort((a, b) => a.weekId.localeCompare(b.weekId));
}

function upcomingWeeks(weeks: WeekRecord[]): WeekRecord[] {
  return scheduleWeeks(weeks).filter((week) => week.status?.toUpperCase() !== "PAUSED");
}

function requireWeek(weeks: WeekRecord[], weekId: string): WeekRecord {
  const week = weeks.find((item) => item.weekId === weekId);
  if (!week) {
    throw new HelloFreshApiError("api", `Week ${weekId} was not found on this account.`);
  }
  return week;
}

function menuParams(subscription: SubscriptionRecord, week: WeekRecord): Record<string, string> | undefined {
  const sku = week.sku || subscription.sku;
  const size = skuSize(sku);
  const servings = subscription.servings || size.servings;
  if (!subscription.customerPlanId || !subscription.deliveryOption || !subscription.postcode || !sku || !servings) {
    return undefined;
  }
  return {
    customerPlanId: subscription.customerPlanId,
    "delivery-option": subscription.deliveryOption,
    exclude: "",
    "exclude-feedback": "true",
    "include-filters": "true",
    "include-future-feedback": "false",
    locale: subscription.locale || "en-US",
    postcode: subscription.postcode,
    preference: subscription.preset ?? "",
    "product-sku": sku,
    servings: String(servings),
    subscription: subscription.id,
    week: week.weekId,
  };
}

function subscriptionFromRaw(raw: Record<string, unknown>): SubscriptionRecord {
  const product = asRecord(raw.product);
  const specs = asRecord(product?.specs);
  const shipping = asRecord(raw.shippingAddress) ?? asRecord(raw.shipping_address);
  const option = asRecord(raw.deliveryOption) ?? asRecord(raw.deliveryTime);
  const customer = asRecord(raw.customer);
  return {
    id: stringField(raw, ["id", "subscriptionId"]) ?? "",
    customerPlanId: stringField(raw, ["customerPlanId", "planId"]),
    customerId: stringField(customer ?? {}, ["id", "uuid"]) ?? stringField(raw, ["customerId"]),
    locale: stringField(raw, ["locale"]),
    preset: stringField(raw, ["preset", "preference", "planPreference"]),
    postcode: stringField(shipping ?? {}, ["postcode", "postalCode"]),
    deliveryOption: stringField(option ?? {}, ["handle"]) ?? stringField(raw, ["deliveryTime"]),
    sku: stringField(product ?? {}, ["sku", "handle"]) ?? stringField(raw, ["productSku"]),
    meals: numberField(specs ?? {}, ["meals"]) ?? numberField(raw, ["meals"]),
    servings: numberField(specs ?? {}, ["size", "servings"]),
    deliveryInterval: numberField(raw, ["deliveryInterval"]),
    status: stringField(raw, ["status"]),
    raw,
  };
}

function weekFromRaw(value: unknown, fallbackSubscription: string): WeekRecord | undefined {
  const raw = asRecord(value);
  if (!raw) {
    return undefined;
  }
  const weekId = stringField(raw, ["id", "week", "weekId"]);
  if (!weekId || !/^\d{4}-W\d{2}$/.test(weekId)) {
    return undefined;
  }
  const product = asRecord(raw.product);
  return {
    weekId,
    deliveryDate: stringField(raw, ["deliveryDate", "delivery_date"]),
    cutoffDate: stringField(raw, ["cutoffDate", "cutoff_date"]),
    status: stringField(raw, ["status", "state"]),
    subscriptionId: stringField(raw, ["subscriptionId", "subscription_id"]) ?? fallbackSubscription,
    sku: stringField(product ?? {}, ["handle", "sku"]),
    meals: [],
    raw,
  };
}

function selectedMealsFromPayload(payload: unknown): SelectedMeal[] {
  const selected: SelectedMeal[] = [];
  for (const meal of asList(payload, ["meals", "courses", "recipes", "items"])) {
    const record = asRecord(meal);
    if (!record) {
      continue;
    }
    const quantity = selectionQuantity(record);
    if (quantity <= 0) {
      continue;
    }
    const recipe = asRecord(record.recipe) ?? record;
    const recipeId = stringField(recipe, ["id", "recipeId"]);
    const recipeName = stringField(recipe, ["name", "title"]);
    if (!recipeId || !recipeName) {
      continue;
    }
    selected.push({ recipeId, recipeName, quantity });
  }
  return selected;
}

function selectionQuantity(record: Record<string, unknown>): number {
  const selection = asRecord(record.selection);
  if (!selection) {
    return 0;
  }
  const quantity = numberField(selection, ["quantity"]) ?? 0;
  if (quantity > 0) {
    return quantity;
  }
  const oneOff = numberField(selection, ["oneOffQuantity"]) ?? 0;
  return oneOff > 0 ? oneOff : 0;
}

function prepMinutes(recipe: Record<string, unknown>): number | null {
  for (const key of ["prepTime", "totalTime"]) {
    const minutes = durationMinutes(recipe[key]);
    if (minutes !== undefined) {
      return minutes;
    }
  }
  return null;
}

function durationMinutes(value: unknown): number | undefined {
  if (typeof value === "number" || typeof value === "string") {
    const numeric = numberField({ value }, ["value"]);
    if (numeric !== undefined) {
      return numeric;
    }
  }
  if (typeof value === "string") {
    return isoDurationMinutes(value);
  }
  return undefined;
}

function isoDurationMinutes(value: string): number | undefined {
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i.exec(value.trim());
  if (!match) {
    return undefined;
  }
  const [, days, hours, minutes, seconds] = match;
  if (!days && !hours && !minutes && !seconds) {
    return undefined;
  }
  const total =
    Number(days ?? 0) * 24 * 60 +
    Number(hours ?? 0) * 60 +
    Number(minutes ?? 0) +
    Number(seconds ?? 0) / 60;
  return Math.round(total);
}

function recipeLabel(recipe: Record<string, unknown>): string | undefined {
  if (typeof recipe.label === "string") {
    const text = recipe.label.trim();
    return text || undefined;
  }
  const label = asRecord(recipe.label);
  if (!label || label.displayLabel === false) {
    return undefined;
  }
  return stringField(label, ["text", "name"])?.trim();
}

const HIDDEN_TAGS = new Set([
  "ineligible-reco",
  "ineligible-for-recommendation",
  "premium-ptn-variety",
]);

const TAG_LABELS: Record<string, { fr: string; en: string }> = {
  "pork-free": { fr: "Sans porc", en: "Pork-free" },
  "classic-plates": { fr: "Assiettes classiques", en: "Classic plates" },
  "regional-specialty": { fr: "Spécialité régionale", en: "Regional specialty" },
  new: { fr: "Nouveau", en: "New" },
  handhelds: { fr: "À la main", en: "Handhelds" },
  "winter-warmers": { fr: "Plats d'hiver", en: "Winter warmers" },
  "certified-product": { fr: "Produit certifié", en: "Certified product" },
  "dinner-bowls": { fr: "Bowls", en: "Dinner bowls" },
  "premium-ingredient": { fr: "Ingrédient premium", en: "Premium ingredient" },
  "world-flavors": { fr: "Saveurs du monde", en: "World flavors" },
  "culinary-technique": { fr: "Technique culinaire", en: "Culinary technique" },
};

function frenchTagLabels(countryCode: string): boolean {
  return countryCode === "fr" || countryCode === "lu";
}

function isKebabSlug(value: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(value);
}

function isTagKey(value: string): boolean {
  return isKebabSlug(value) || Boolean(TAG_LABELS[value]) || HIDDEN_TAGS.has(value);
}

interface ParsedTag {
  name: string;
  keys: string[];
  display: boolean | undefined;
}

function parsedTag(tag: unknown): ParsedTag | undefined {
  if (typeof tag === "string") {
    const name = tag.trim();
    if (!name) {
      return undefined;
    }
    const key = name.toLowerCase();
    return { name, keys: isTagKey(key) ? [key] : [], display: undefined };
  }
  const record = asRecord(tag);
  if (!record) {
    return undefined;
  }
  const name = stringField(record, ["name", "type", "slug"])?.trim();
  if (!name) {
    return undefined;
  }
  const keys: string[] = [];
  for (const value of [stringField(record, ["type"]), stringField(record, ["slug"]), stringField(record, ["name"])]) {
    const key = value?.trim().toLowerCase();
    if (key && isTagKey(key) && !keys.includes(key)) {
      keys.push(key);
    }
  }
  const display = record.displayLabel;
  return { name, keys, display: typeof display === "boolean" ? display : undefined };
}

function tagLabel(tag: ParsedTag, french: boolean): string | undefined {
  const translation = tag.keys.map((key) => TAG_LABELS[key]).find((item) => item);
  const nameKey = tag.name.toLowerCase();
  const nameIsSlug = isTagKey(nameKey);
  if (translation && nameIsSlug) {
    return french ? translation.fr : translation.en;
  }
  if (nameIsSlug) {
    return tag.display === true ? tag.name : undefined;
  }
  return tag.name;
}

function recipeTags(recipe: Record<string, unknown>, label: string | undefined, french: boolean): string[] {
  if (!Array.isArray(recipe.tags)) {
    return [];
  }
  const named = recipe.tags.flatMap((tag) => {
    const parsed = parsedTag(tag);
    return parsed ? [parsed] : [];
  });
  const eligible = named.filter((tag) => tag.display !== false && !tag.keys.some((key) => HIDDEN_TAGS.has(key)));
  const displayed = eligible.filter((tag) => tag.display === true);
  const source = displayed.length > 0 ? displayed : eligible;
  const tags: string[] = [];
  const labelKey = label?.toLocaleLowerCase();
  for (const tag of source) {
    const text = tagLabel(tag, french);
    if (!text) {
      continue;
    }
    const key = text.toLocaleLowerCase();
    if (key === labelKey || tags.some((item) => item.toLocaleLowerCase() === key)) {
      continue;
    }
    tags.push(text);
  }
  return tags;
}

interface RecipeNutrition {
  calories: number | null;
  allergens: string[] | null;
  allergenTraces: string[] | null;
}

function nutritionFromRecipe(recipe: Record<string, unknown>): RecipeNutrition {
  return {
    calories: caloriesFromNutrition(recipe.nutrition),
    ...allergensFromList(recipe.allergens),
  };
}

function caloriesFromNutrition(nutrition: unknown): number | null {
  if (Array.isArray(nutrition)) {
    for (const item of nutrition) {
      const record = asRecord(item);
      if (!record) {
        continue;
      }
      const unit = stringField(record, ["unit"])?.toLowerCase() ?? "";
      const name = stringField(record, ["name"])?.toLowerCase() ?? "";
      if (unit === "kj" || name.includes("(kj)") || name.endsWith(" kj")) {
        continue;
      }
      const amount = numberField(record, ["amount", "value"]);
      if (amount === undefined) {
        continue;
      }
      if (unit === "kcal" || name.includes("kcal") || name.includes("calorie")) {
        return amount;
      }
    }
    return null;
  }
  const record = asRecord(nutrition);
  if (!record) {
    return null;
  }
  return numberField(record, ["calories", "energyKcal", "kcal"]) ?? null;
}

function allergensFromList(value: unknown): { allergens: string[] | null; allergenTraces: string[] | null } {
  if (!Array.isArray(value)) {
    return { allergens: null, allergenTraces: null };
  }
  const allergens: string[] = [];
  const allergenTraces: string[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      const name = item.trim();
      if (name && !isGenericAllergenBanner({}, name)) {
        allergens.push(name);
      }
      continue;
    }
    const record = asRecord(item);
    if (!record) {
      continue;
    }
    const name = stringField(record, ["name"])?.trim();
    if (!name || isGenericAllergenBanner(record, name)) {
      continue;
    }
    if (record.tracesOf === true) {
      allergenTraces.push(name);
    } else {
      allergens.push(name);
    }
  }
  return { allergens: uniqueNames(allergens), allergenTraces: uniqueNames(allergenTraces) };
}

function isGenericAllergenBanner(record: Record<string, unknown>, name: string): boolean {
  const type = stringField(record, ["type"])?.toLowerCase();
  const slug = stringField(record, ["slug"])?.toLowerCase();
  if (type === "maycontaintracesofallergens" || slug === "peut-contenir-des-traces-dallergenes") {
    return true;
  }
  return /peut contenir des traces d['’]allerg/i.test(name);
}

function uniqueNames(names: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const name of names) {
    const key = name.toLocaleLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(name);
  }
  return unique;
}

function recipesFromPayload(payload: unknown, french: boolean): MenuRecipeDraft[] {
  const meals = [
    ...asList(payload, ["meals", "courses", "recipes", "items"]),
  ];
  const recipes: MenuRecipeDraft[] = [];
  for (const meal of meals) {
    const record = asRecord(meal);
    if (!record) {
      continue;
    }
    const recipe = asRecord(record.recipe) ?? record;
    const id = stringField(recipe, ["id", "recipeId"]);
    const name = stringField(recipe, ["name", "title"]);
    if (!id || !name) {
      continue;
    }
    const label = recipeLabel(recipe);
    const nutrition = nutritionFromRecipe(recipe);
    recipes.push({
      caloriesFromMenu: nutrition.calories !== null,
      allergensFromMenu: nutrition.allergens !== null,
      summary: {
        id,
        name,
        description: stringField(recipe, ["headline", "description"]) ?? "",
        imageUrl: stringField(recipe, ["imagePath", "image", "imageUrl"]),
        prepTime: prepMinutes(recipe),
        ...(label ? { label } : {}),
        tags: recipeTags(recipe, label, french),
        calories: nutrition.calories,
        allergens: nutrition.allergens ?? [],
        allergenTraces: nutrition.allergenTraces ?? [],
        index: numberField(record, ["index"]),
      },
    });
  }
  return recipes;
}

function preferencesFromProfile(payload: unknown): Record<string, unknown> {
  const record = asRecord(payload) ?? {};
  const taste = asRecord(record.taste) ?? record;
  const dietary = stringArray(taste.dietaryPreferences) ?? stringArray(taste.diets) ?? [];
  const allergens = stringArray(taste.exclusions) ?? stringArray(taste.allergens) ?? [];
  const cuisines = stringArray(taste.cuisines) ?? stringArray(taste.cuisinePreferences) ?? [];
  return {
    dietaryPreferences: dietary,
    allergens,
    cuisinePreferences: cuisines,
    familyFriendly: taste.familyFriendly === true,
    vegetarian: taste.vegetarian === true || dietary.some((item) => /vegetarian/i.test(item)),
  };
}

const MAX_CART_QUANTITY = 10;

function cartQuantity(value: number | undefined): number {
  if (value === undefined) {
    return 1;
  }
  if (!Number.isInteger(value) || value < 1 || value > MAX_CART_QUANTITY) {
    throw new HelloFreshApiError(
      "api",
      `quantity must be a whole number from 1 to ${MAX_CART_QUANTITY}.`
    );
  }
  return value;
}

function weekPortions(subscription: SubscriptionRecord, sku: string | undefined): number | undefined {
  const fromSku = skuSize(sku).servings;
  if (fromSku && fromSku > 0) {
    return fromSku;
  }
  return planPortions(subscription);
}

function planPortions(subscription: SubscriptionRecord): number | undefined {
  if (subscription.servings && subscription.servings > 0) {
    return subscription.servings;
  }
  const servings = skuSize(subscription.sku).servings;
  return servings && servings > 0 ? servings : undefined;
}

function cartMealCount(subscription: SubscriptionRecord, totalQuantity: number): number {
  if (totalQuantity >= 2) {
    return totalQuantity;
  }
  const planMeals = subscription.meals ?? skuSize(subscription.sku).meals;
  if (planMeals && planMeals >= 2) {
    return planMeals;
  }
  return totalQuantity;
}

function resizePlanSku(sku: string, meals: number, servings: number): string | undefined {
  const match = /^(?<prefix>.+-)(?<meals>\d+)-(?<servings>\d+)-(?<tail>\d+)$/.exec(sku);
  if (!match?.groups) {
    return undefined;
  }
  return `${match.groups.prefix}${meals}-${servings}-${match.groups.tail}`;
}

function skuSize(sku: string | undefined): { meals?: number; servings?: number } {
  if (!sku) {
    return {};
  }
  const match = /^.+-(\d+)-(\d+)-\d+$/.exec(sku);
  if (!match) {
    return {};
  }
  return { meals: Number(match[1]), servings: Number(match[2]) };
}

function formatCutoff(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/.exec(value);
  return match?.[1] ?? value;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asList(value: unknown, keys: string[]): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  const record = asRecord(value);
  if (!record) {
    return [];
  }
  for (const key of keys) {
    if (Array.isArray(record[key])) {
      return record[key] as unknown[];
    }
  }
  return [];
}

function recipeImageUrl(recipe: Record<string, unknown>): string {
  const values: string[] = [];
  for (const key of ["imageLink", "imagePath", "image", "imageUrl"]) {
    const value = stringField(recipe, [key]);
    if (value && !values.includes(value)) {
      values.push(value);
    }
  }
  if (values.length === 0) {
    throw new HelloFreshApiError("api", "This recipe has no image.");
  }
  for (const value of values) {
    const url = publicRecipeImageUrl(value);
    if (url) {
      return url;
    }
  }
  throw new HelloFreshApiError("api", "This recipe image is not on the HelloFresh CDN.");
}

/** Public img.hellofresh.com URL, or undefined when the value is not a HelloFresh image. */
export function publicRecipeImageUrl(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) {
    return undefined;
  }
  return cdnUrlForImageValue(value);
}

function imageUrlFromRecipe(recipe: Record<string, unknown>): string | undefined {
  for (const key of ["imageLink", "imagePath", "image", "imageUrl"]) {
    const url = publicRecipeImageUrl(stringField(recipe, [key]));
    if (url) {
      return url;
    }
  }
  return undefined;
}

function ingredientLines(recipe: Record<string, unknown>): string[] {
  const catalog = ingredientCatalog(recipe.ingredients);
  const portion = pickYield(recipe.yields);
  if (!portion) {
    return uniqueNames(catalog.lines);
  }
  const lines: string[] = [];
  const used = new Set<string>();
  for (const item of portion) {
    const record = asRecord(item);
    if (!record) {
      continue;
    }
    const id = stringField(record, ["id", "uuid"]);
    const name = (id ? catalog.names.get(id) : undefined) ?? plainText(stringField(record, ["name", "title"]) ?? "");
    if (!name) {
      continue;
    }
    if (id) {
      used.add(id);
    }
    lines.push(formatAmount(record, name) ?? name);
  }
  for (const [id, name] of catalog.names) {
    if (!used.has(id)) {
      lines.push(name);
    }
  }
  return uniqueNames([...lines, ...catalog.loose]);
}

function ingredientCatalog(value: unknown): { names: Map<string, string>; lines: string[]; loose: string[] } {
  const names = new Map<string, string>();
  const lines: string[] = [];
  const loose: string[] = [];
  if (!Array.isArray(value)) {
    return { names, lines, loose };
  }
  for (const item of value) {
    if (typeof item === "string") {
      const name = plainText(item);
      if (name) {
        loose.push(name);
        lines.push(name);
      }
      continue;
    }
    const record = asRecord(item);
    if (!record) {
      continue;
    }
    const name = plainText(stringField(record, ["name", "title"]) ?? "");
    if (!name) {
      continue;
    }
    const id = stringField(record, ["id", "uuid"]);
    if (id) {
      names.set(id, name);
    } else {
      loose.push(formatAmount(record, name) ?? name);
    }
    lines.push(formatAmount(record, name) ?? name);
  }
  return { names, lines, loose };
}

function pickYield(value: unknown): unknown[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  const records = value.flatMap((item) => {
    const record = asRecord(item);
    return record ? [record] : [];
  });
  const preferred = records.find((item) => numberField(item, ["yields", "servings"]) === 2) ?? records[0];
  return Array.isArray(preferred?.ingredients) ? preferred.ingredients : undefined;
}

function formatAmount(record: Record<string, unknown>, name: string): string | undefined {
  const amount = numberField(record, ["amount", "quantity"]);
  const unit = stringField(record, ["unit"])?.trim();
  if (amount === undefined && !unit) {
    return undefined;
  }
  const quantity = amount === undefined ? "" : Number.isInteger(amount) ? String(amount) : String(amount);
  return [quantity, unit, name].filter((part) => part).join(" ");
}

function stepLines(recipe: Record<string, unknown>): string[] {
  const raw = Array.isArray(recipe.steps)
    ? recipe.steps
    : Array.isArray(recipe.instructions)
      ? recipe.instructions
      : [];
  const lines: string[] = [];
  for (const item of raw) {
    if (typeof item === "string") {
      const text = plainText(item);
      if (text) {
        lines.push(text);
      }
      continue;
    }
    const record = asRecord(item);
    if (!record) {
      continue;
    }
    const text = plainText(
      stringField(record, ["instructions", "instruction", "step", "description", "text"]) ??
        stringField(record, ["instructionsHTML", "instructionsHtml"]) ??
        ""
    );
    if (text) {
      lines.push(text);
    }
  }
  return lines;
}

function plainText(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function cdnUrlForImageValue(raw: string): string | undefined {
  const value = raw.trim();
  if (!value) {
    return undefined;
  }
  if (helloFreshCdnUrl(value)) {
    return value;
  }
  const relative = relativeImagePath(value);
  if (!relative) {
    return undefined;
  }
  return `${RECIPE_IMAGE_CDN_PREFIX}${relative}`;
}

function relativeImagePath(value: string): string | undefined {
  if (!value.includes("://") && value.startsWith("/") && !value.startsWith("//")) {
    return value;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return undefined;
  }
  const index = url.pathname.indexOf("/image/");
  if (index < 0) {
    return undefined;
  }
  return url.pathname.slice(index);
}

function helloFreshCdnUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "img.hellofresh.com";
  } catch {
    return false;
  }
}

function imageMimeType(header: string | null): string {
  const mime = header?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!mime.startsWith("image/") || /\s/.test(mime)) {
    throw new HelloFreshApiError("api", "HelloFresh did not return an image.");
  }
  return mime;
}

function stringField(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return undefined;
}

function numberField(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }
  return undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value.filter((item): item is string => typeof item === "string");
  return items;
}

function nestedString(record: Record<string, unknown>, path: string[]): string | undefined {
  let current: unknown = record;
  for (const key of path) {
    const next = asRecord(current);
    if (!next) {
      return undefined;
    }
    current = next[key];
  }
  return typeof current === "string" ? current : undefined;
}
