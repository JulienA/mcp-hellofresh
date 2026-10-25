"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HelloFreshApi = exports.RATE_RECIPE_UNSUPPORTED = exports.RECONNECT_MESSAGE = exports.HelloFreshApiError = void 0;
exports.accountFromAuthPayload = accountFromAuthPayload;
const auth_js_1 = require("./auth.js");
const accounts_js_1 = require("./accounts.js");
const countries_js_1 = require("./countries.js");
const log_js_1 = require("./log.js");
class HelloFreshApiError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = "HelloFreshApiError";
        this.code = code;
    }
}
exports.HelloFreshApiError = HelloFreshApiError;
exports.RECONNECT_MESSAGE = "HelloFresh access expired. Disconnect the connector in Claude or ChatGPT and connect it again, then sign in on the authorize page. Do not send a password in chat.";
exports.RATE_RECIPE_UNSUPPORTED = "rate_recipe is not available through the HelloFresh API this connector uses. Rate the recipe on the HelloFresh website.";
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const RECIPE_IMAGE_CDN_PREFIX = "https://img.hellofresh.com/w_800,c_limit,f_jpg,q_auto,fl_lossy/hellofresh_s3";
const MAX_RECIPE_IMAGE_BYTES = 2 * 1024 * 1024;
class HelloFreshApi {
    fetchImpl;
    hooks;
    mutex = new auth_js_1.AsyncMutex();
    account;
    country;
    reloginTried = false;
    constructor(account, fetchImpl, hooks = {}) {
        this.fetchImpl = fetchImpl;
        this.hooks = hooks;
        const country = (0, countries_js_1.helloFreshCountry)(account.country);
        if (!country) {
            throw new HelloFreshApiError("api", `Unknown HelloFresh country: ${account.country}`);
        }
        this.country = country;
        this.account = account;
    }
    get email() {
        return this.account.email;
    }
    static async login(input) {
        const country = requireCountry(input.country);
        const fetchImpl = input.fetchImpl ?? fetch;
        const now = Math.floor(Date.now() / 1000);
        const payload = await authPost(fetchImpl, country, "/gw/login", {
            username: input.email.trim(),
            password: input.password,
        });
        const account = accountFromAuthPayload(payload, country.code, (0, accounts_js_1.normalizeEmail)(input.email), now);
        const api = new HelloFreshApi(account, fetchImpl);
        try {
            await api.assertSubscriptions();
        }
        catch (error) {
            if (error instanceof HelloFreshApiError && error.code === "reconnect_required") {
                throw new HelloFreshApiError("invalid_credentials", "HelloFresh did not accept these credentials.");
            }
            throw error;
        }
        const discovered = await api.discoverEmail();
        if (discovered) {
            api.account = { ...api.account, email: discovered, userId: (0, accounts_js_1.userIdFor)(country.code, discovered) };
        }
        return api;
    }
    static async fromPasted(input) {
        const country = requireCountry(input.country);
        const parsed = input.parsed;
        if (!parsed?.accessToken) {
            throw new HelloFreshApiError("invalid_token", "That apiV2Auth value could not be read.");
        }
        const fetchImpl = input.fetchImpl ?? fetch;
        const now = Math.floor(Date.now() / 1000);
        const claims = (0, accounts_js_1.decodeJwtClaims)(parsed.accessToken);
        const account = {
            userId: "pending",
            email: (0, accounts_js_1.emailFromClaims)(claims) ?? "",
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
        }
        catch (error) {
            if (error instanceof HelloFreshApiError && error.code === "reconnect_required") {
                throw new HelloFreshApiError("invalid_token", "HelloFresh rejected that apiV2Auth value.");
            }
            throw error;
        }
        const email = (await api.discoverEmail()) ?? (account.email || undefined);
        if (!email) {
            throw new HelloFreshApiError("missing_email", "HelloFresh did not return an email for this account, so it cannot be linked.");
        }
        api.account = {
            ...api.account,
            email,
            userId: (0, accounts_js_1.userIdFor)(country.code, email),
            savedAt: new Date().toISOString(),
        };
        return api;
    }
    toStoredAccount() {
        return { ...this.account, userId: (0, accounts_js_1.userIdFor)(this.account.country, this.account.email) };
    }
    status() {
        return {
            authenticated: true,
            email: this.account.email,
            country: this.account.country,
            accessTokenValid: !this.accessExpiring(0),
            savedAt: this.account.savedAt,
            reconnectRequired: false,
        };
    }
    async getMenu(weekOffset = 0) {
        return this.mutex.runExclusive(async () => {
            const { subscription, weeks } = await this.loadWeeks();
            const upcoming = upcomingWeeks(weeks);
            const week = upcoming[weekOffset];
            if (!week) {
                throw new HelloFreshApiError("api", `No HelloFresh menu week at offset ${weekOffset}.`);
            }
            const recipes = await this.recipesForWeek(subscription, week);
            return { weekId: week.weekId, recipes };
        });
    }
    async getRecipe(recipeId) {
        return this.mutex.runExclusive(() => this.loadRecipe(recipeId));
    }
    async getRecipeImage(recipeId) {
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
    async loadRecipe(recipeId) {
        const bare = recipeId.split("-", 1)[0]?.trim();
        if (!bare) {
            throw new HelloFreshApiError("api", "A recipe id is required.");
        }
        const payload = await this.getJson(`/gw/recipes/recipes/${encodeURIComponent(bare)}`, {
            country: this.country.apiCountry,
            locale: this.country.locale,
        });
        return payload && typeof payload === "object" ? payload : { id: bare };
    }
    async fetchPublicImage(url) {
        const response = await loggedFetch(this.fetchImpl, url, {
            method: "GET",
            headers: {
                Accept: "image/jpeg,image/*",
                "User-Agent": USER_AGENT,
            },
        }, { country: this.country.code, userId: this.account.userId });
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
            throw new HelloFreshApiError("api", bytes.byteLength === 0
                ? "HelloFresh did not return an image."
                : "The recipe image is larger than 2 MB.");
        }
        return { mimeType, data: bytes.toString("base64") };
    }
    async selectMeals(weekId, meals) {
        return this.mutex.runExclusive(async () => {
            const { subscription, weeks } = await this.loadWeeks();
            const week = weeks.find((item) => item.weekId === weekId);
            if (!week) {
                throw new HelloFreshApiError("api", `Week ${weekId} was not found on this account.`);
            }
            const recipes = await this.recipesForWeek(subscription, week);
            // quantity is how many times the recipe is in the box. Portions stay on the plan.
            const selected = [];
            for (const meal of meals) {
                const recipe = recipes.find((item) => item.id === meal.recipeId);
                if (!recipe || recipe.index === undefined) {
                    throw new HelloFreshApiError("api", `Recipe ${meal.recipeId} is not on the menu for ${weekId}.`);
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
                throw new HelloFreshApiError("api", `Week ${weekId} is missing the cart details HelloFresh needs to save a selection.`);
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
    async skipWeek(weekId) {
        return this.mutex.runExclusive(async () => {
            const { weeks } = await this.loadWeeks();
            const week = requireWeek(weeks, weekId);
            await this.patchDeliveryStatus(week, "PAUSED");
            return { weekId, status: "PAUSED" };
        });
    }
    async getDeliveries() {
        return this.mutex.runExclusive(async () => {
            const { subscription, weeks } = await this.loadWeeks();
            const deliveries = [];
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
    async modifyDelivery(weekId, newDate) {
        return this.mutex.runExclusive(async () => {
            const { subscription, weeks } = await this.loadWeeks();
            const week = requireWeek(weeks, weekId);
            const options = await this.deliveryOptions(subscription);
            const match = options.find((option) => option.date?.startsWith(newDate));
            if (!match) {
                throw new HelloFreshApiError("api", `HelloFresh has no delivery option on ${newDate} for this plan.`);
            }
            await this.request("POST", `/gw/api/subscriptions/${encodeURIComponent(week.subscriptionId || subscription.id)}/oneoff${this.query()}`, {
                id: week.subscriptionId || subscription.id,
                delivery_option: match.handle,
                week: weekId,
                source: "reschedule-delivery-feature",
            });
            return { weekId, deliveryOption: match.handle, date: match.date ?? newDate };
        });
    }
    async getPreferences() {
        return this.mutex.runExclusive(async () => {
            const profile = await this.getJson("/gw/profile-service/v2/customers/me/profile", this.profileParams());
            return preferencesFromProfile(profile);
        });
    }
    async updatePreferences(changes) {
        return this.mutex.runExclusive(async () => {
            const current = await this.getJson("/gw/profile-service/v2/customers/me/profile", this.profileParams());
            const taste = current && typeof current === "object" && "taste" in current && typeof current.taste === "object"
                ? { ...current.taste }
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
            const updated = await this.request("PATCH", `/gw/profile-service/v2/customers/me/profile${this.query(this.profileParams("food-profile"))}`, { taste });
            return preferencesFromProfile(updated ?? { taste });
        });
    }
    async getSubscription() {
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
    async modifySubscription(changes) {
        return this.mutex.runExclusive(async () => {
            const { subscription } = await this.loadWeeks();
            const size = skuSize(subscription.sku);
            const meals = changes.mealsPerWeek ?? subscription.meals ?? size.meals;
            const servings = changes.servingsPerMeal ?? subscription.servings ?? size.servings;
            if (!subscription.customerPlanId || !meals || !servings) {
                throw new HelloFreshApiError("api", "This subscription does not expose a plan that can be changed.");
            }
            const handle = (await this.matchingProductHandle(subscription, meals, servings)) ||
                resizePlanSku(subscription.sku || "", meals, servings);
            if (!handle) {
                throw new HelloFreshApiError("api", "HelloFresh did not return a product handle for that box size.");
            }
            await this.request("PATCH", `/gw/api/plans/${encodeURIComponent(subscription.customerPlanId)}${this.query()}`, { productHandle: handle });
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
    async getPastOrders(limit) {
        return this.mutex.runExclusive(async () => {
            const payload = await this.getJson("/gw/my-deliveries/past-deliveries", {
                country: this.country.apiCountry,
                locale: this.country.locale,
            });
            const weeks = asList(payload, ["weeks", "items", "data"])
                .map(asRecord)
                .filter((item) => Boolean(item));
            return weeks.slice(0, limit).map((week) => ({
                orderId: stringField(week, ["id", "week", "weekId"]) ?? "",
                deliveryDate: stringField(week, ["deliveryDate", "delivery_date"]) ?? "",
                status: stringField(week, ["status", "state"]) ?? "",
                meals: [],
                totalPrice: 0,
            }));
        });
    }
    async assertSubscriptions() {
        const payload = await this.getJson("/gw/api/customers/me/subscriptions");
        const items = asList(payload, ["items"]);
        if (items.length === 0) {
            throw new HelloFreshApiError("invalid_token", "HelloFresh returned no subscription for this account.");
        }
    }
    async discoverEmail() {
        try {
            const info = await this.getJson("/gw/api/customers/me/info");
            return (0, accounts_js_1.findEmail)(info);
        }
        catch {
            return undefined;
        }
    }
    async loadWeeks() {
        const subscription = await this.primarySubscription();
        const payload = await this.getJson("/gw/api/customers/me/deliveries", {
            country: this.country.apiCountry,
            locale: this.country.locale,
        });
        const weeks = asList(payload, ["items", "deliveries", "weeks", "data"])
            .map((item) => weekFromRaw(item, subscription.id))
            .filter((item) => Boolean(item));
        return { subscription, weeks };
    }
    async primarySubscription() {
        const payload = await this.getJson("/gw/api/customers/me/subscriptions");
        const first = asList(payload, ["items"]).map(asRecord).find((item) => item);
        if (!first) {
            throw new HelloFreshApiError("reconnect_required", exports.RECONNECT_MESSAGE);
        }
        return subscriptionFromRaw(first);
    }
    async selectedMealsForWeek(subscription, week) {
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
        }
        catch {
            return embedded;
        }
    }
    async recipesForWeek(subscription, week) {
        const embedded = recipesFromPayload(week.raw);
        const params = menuParams(subscription, week);
        if (!params) {
            return embedded;
        }
        try {
            const payload = await this.getJson("/gw/my-deliveries/menu", params);
            if (payload && typeof payload === "object" && "week" in payload && payload.week && payload.week !== week.weekId) {
                return embedded;
            }
            const fromMenu = recipesFromPayload(payload);
            return fromMenu.length > 0 ? fromMenu : embedded;
        }
        catch (error) {
            if (embedded.length > 0) {
                return embedded;
            }
            throw error;
        }
    }
    async patchDeliveryStatus(week, status) {
        if (!week.subscriptionId || !week.deliveryDate) {
            throw new HelloFreshApiError("api", `Week ${week.weekId} cannot be skipped without a delivery date.`);
        }
        const delivery = {
            deliveryDate: week.deliveryDate,
            status,
            subscriptionId: week.subscriptionId,
            id: week.weekId,
        };
        if (week.cutoffDate) {
            delivery.cutoffDate = week.cutoffDate;
        }
        await this.request("PATCH", `/gw/api/subscriptions/${encodeURIComponent(week.subscriptionId)}/delivery_dates/${encodeURIComponent(week.weekId)}${this.query()}`, { delivery });
    }
    async deliveryOptions(subscription) {
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
        const options = [];
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
    async cartProductSku(subscription, mealCount, portions, weekSku) {
        if (portions && mealCount >= 2) {
            const handle = (await this.matchingProductHandle(subscription, mealCount, portions)) ||
                resizePlanSku(subscription.sku || "", mealCount, portions);
            if (handle) {
                return handle;
            }
        }
        return subscription.sku || weekSku || "";
    }
    async matchingProductHandle(subscription, meals, servings) {
        try {
            const payload = await this.getJson(`/gw/api/subscriptions/${encodeURIComponent(subscription.id)}/product_options`, { country: this.country.apiCountry, locale: subscription.locale || this.country.locale });
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
        }
        catch {
            return undefined;
        }
        return undefined;
    }
    query(params = {}) {
        const search = new URLSearchParams({
            country: this.country.apiCountry,
            locale: this.country.locale,
            ...params,
        });
        return `?${search}`;
    }
    profileParams(source) {
        return {
            brand: "BRAND_HELLOFRESH",
            exclusion: "v2",
            regionCode: this.country.apiCountry,
            ...(source ? { source } : {}),
        };
    }
    accessExpiring(skewSeconds) {
        return Math.floor(Date.now() / 1000) + skewSeconds >= this.account.issuedAt + this.account.expiresIn;
    }
    async getJson(path, params) {
        const search = params ? `?${new URLSearchParams(params)}` : this.query();
        const url = path.includes("?") ? path : `${path}${search}`;
        return this.request("GET", url);
    }
    async request(method, path, body, extraHeaders, retried = false) {
        if (this.accessExpiring(60) && this.account.refreshToken) {
            await this.refresh();
        }
        const response = await loggedFetch(this.fetchImpl, `${this.country.baseUrl}${path}`, {
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
        }, { country: this.country.code, userId: this.account.userId, retried });
        if (response.status === 401 && !retried && this.account.refreshToken) {
            await this.refresh();
            return this.request(method, path, body, extraHeaders, true);
        }
        if (response.status === 401) {
            throw new HelloFreshApiError("reconnect_required", exports.RECONNECT_MESSAGE);
        }
        return readApiResponse(response, "HelloFresh request failed", "api");
    }
    async refresh() {
        if (!this.account.refreshToken) {
            await this.tryRelogin();
            return;
        }
        const response = await loggedFetch(this.fetchImpl, `${this.country.baseUrl}/gw/refresh${this.query()}`, {
            method: "POST",
            headers: {
                Accept: "*/*",
                "Content-Type": "application/json",
                Authorization: `Bearer ${this.account.accessToken}`,
                Origin: this.country.baseUrl,
                Referer: `${this.country.baseUrl}/login`,
                "User-Agent": USER_AGENT,
            },
            body: JSON.stringify({ refresh_token: this.account.refreshToken }),
        }, { country: this.country.code, userId: this.account.userId });
        let payload;
        try {
            payload = await readApiResponse(response, exports.RECONNECT_MESSAGE, "reconnect_required");
        }
        catch (error) {
            if (error instanceof HelloFreshApiError && error.code !== "bot_blocked" && error.code !== "rate_limited") {
                await this.tryRelogin();
                return;
            }
            throw error;
        }
        const now = Math.floor(Date.now() / 1000);
        const next = accountFromAuthPayload(payload, this.account.country, this.account.email, now);
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
    async tryRelogin() {
        if (!this.hooks.relogin || this.reloginTried) {
            throw new HelloFreshApiError("reconnect_required", exports.RECONNECT_MESSAGE);
        }
        this.reloginTried = true;
        this.account = await this.hooks.relogin();
        await this.hooks.onUpdate?.(this.toStoredAccount());
    }
}
exports.HelloFreshApi = HelloFreshApi;
function accountFromAuthPayload(payload, country, email, now) {
    const record = asRecord(payload);
    const accessToken = record ? stringField(record, ["access_token", "accessToken"]) : undefined;
    if (!accessToken) {
        throw new HelloFreshApiError("api", "HelloFresh did not return an access token.");
    }
    const refreshToken = record ? stringField(record, ["refresh_token", "refreshToken"]) : undefined;
    const expiresIn = (record && numberField(record, ["expires_in", "expiresIn"])) ?? 1800;
    const refreshExpiresIn = record ? numberField(record, ["refresh_expires_in", "refreshExpiresIn"]) : undefined;
    return {
        userId: (0, accounts_js_1.userIdFor)(country, email),
        email: (0, accounts_js_1.normalizeEmail)(email),
        country: (0, countries_js_1.helloFreshCountry)(country)?.code ?? country,
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
async function loggedFetch(fetchImpl, url, init, extra) {
    const started = Date.now();
    const method = (init?.method ?? "GET").toUpperCase();
    const path = (0, log_js_1.logPath)(url);
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
            log_js_1.log.warn("hellofresh.request", fields);
        }
        else {
            log_js_1.log.info("hellofresh.request", fields);
        }
        return response;
    }
    catch (error) {
        log_js_1.log.warn("hellofresh.request", {
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
async function authPost(fetchImpl, country, path, body) {
    const params = new URLSearchParams({ country: country.apiCountry, locale: country.locale });
    let response;
    try {
        response = await loggedFetch(fetchImpl, `${country.baseUrl}${path}?${params}`, {
            method: "POST",
            headers: {
                Accept: "application/json, text/plain, */*",
                "Content-Type": "application/json",
                Origin: country.baseUrl,
                Referer: `${country.baseUrl}/login`,
                "User-Agent": USER_AGENT,
            },
            body: JSON.stringify(body),
        }, { country: country.code });
    }
    catch {
        throw new HelloFreshApiError("api", "HelloFresh could not be reached.");
    }
    return readApiResponse(response, "HelloFresh did not accept these credentials.", "invalid_credentials");
}
async function readApiResponse(response, fallback, failure) {
    const contentType = response.headers.get("content-type") ?? "";
    const text = await response.text();
    if (looksBlocked(response.status, contentType, text)) {
        throw new HelloFreshApiError("bot_blocked", "HelloFresh blocked the request before it reached the account. This is not a wrong password.");
    }
    if (response.status === 429) {
        throw new HelloFreshApiError("rate_limited", "HelloFresh temporarily locked sign-in. Wait and try again.");
    }
    if (response.status === 400 || response.status === 401 || response.status === 403) {
        if (failure === "invalid_credentials" && socialSignInRequired(text)) {
            throw new HelloFreshApiError("invalid_credentials", "This HelloFresh account signs in with Google, Apple, or Facebook. Sign in on the HelloFresh website, then paste apiV2Auth.");
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
        return JSON.parse(text);
    }
    catch {
        return undefined;
    }
}
function socialSignInRequired(body) {
    let parsed;
    try {
        parsed = JSON.parse(body);
    }
    catch {
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
function looksBlocked(status, contentType, body) {
    if (contentType.includes("text/html") && status >= 400) {
        return true;
    }
    const sample = body.slice(0, 400).toLowerCase();
    return status === 403 && (sample.includes("cloudflare") || sample.includes("just a moment") || sample.includes("<html"));
}
function requireCountry(code) {
    const country = (0, countries_js_1.helloFreshCountry)(code);
    if (!country) {
        throw new HelloFreshApiError("api", "Choose a HelloFresh country.");
    }
    return country;
}
const TERMINAL_DELIVERY_STATUSES = new Set(["DELIVERED", "DONATED", "CANCELLED"]);
function scheduleWeeks(weeks) {
    return [...weeks]
        .filter((week) => !TERMINAL_DELIVERY_STATUSES.has(week.status?.toUpperCase() ?? ""))
        .sort((a, b) => a.weekId.localeCompare(b.weekId));
}
function upcomingWeeks(weeks) {
    return scheduleWeeks(weeks).filter((week) => week.status?.toUpperCase() !== "PAUSED");
}
function requireWeek(weeks, weekId) {
    const week = weeks.find((item) => item.weekId === weekId);
    if (!week) {
        throw new HelloFreshApiError("api", `Week ${weekId} was not found on this account.`);
    }
    return week;
}
function menuParams(subscription, week) {
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
function subscriptionFromRaw(raw) {
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
function weekFromRaw(value, fallbackSubscription) {
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
function selectedMealsFromPayload(payload) {
    const selected = [];
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
function selectionQuantity(record) {
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
function recipesFromPayload(payload) {
    const meals = [
        ...asList(payload, ["meals", "courses", "recipes", "items"]),
    ];
    const recipes = [];
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
        recipes.push({
            id,
            name,
            description: stringField(recipe, ["headline", "description"]) ?? "",
            imageUrl: stringField(recipe, ["imagePath", "image", "imageUrl"]),
            prepTime: numberField(recipe, ["prepTime", "totalTime"]) ?? 0,
            tags: [],
            index: numberField(record, ["index"]),
        });
    }
    return recipes;
}
function preferencesFromProfile(payload) {
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
function cartQuantity(value) {
    if (value === undefined) {
        return 1;
    }
    if (!Number.isInteger(value) || value < 1 || value > MAX_CART_QUANTITY) {
        throw new HelloFreshApiError("api", `quantity must be a whole number from 1 to ${MAX_CART_QUANTITY}.`);
    }
    return value;
}
function weekPortions(subscription, sku) {
    const fromSku = skuSize(sku).servings;
    if (fromSku && fromSku > 0) {
        return fromSku;
    }
    return planPortions(subscription);
}
function planPortions(subscription) {
    if (subscription.servings && subscription.servings > 0) {
        return subscription.servings;
    }
    const servings = skuSize(subscription.sku).servings;
    return servings && servings > 0 ? servings : undefined;
}
function cartMealCount(subscription, totalQuantity) {
    if (totalQuantity >= 2) {
        return totalQuantity;
    }
    const planMeals = subscription.meals ?? skuSize(subscription.sku).meals;
    if (planMeals && planMeals >= 2) {
        return planMeals;
    }
    return totalQuantity;
}
function resizePlanSku(sku, meals, servings) {
    const match = /^(?<prefix>.+-)(?<meals>\d+)-(?<servings>\d+)-(?<tail>\d+)$/.exec(sku);
    if (!match?.groups) {
        return undefined;
    }
    return `${match.groups.prefix}${meals}-${servings}-${match.groups.tail}`;
}
function skuSize(sku) {
    if (!sku) {
        return {};
    }
    const match = /^.+-(\d+)-(\d+)-\d+$/.exec(sku);
    if (!match) {
        return {};
    }
    return { meals: Number(match[1]), servings: Number(match[2]) };
}
function formatCutoff(value) {
    if (!value) {
        return undefined;
    }
    const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/.exec(value);
    return match?.[1] ?? value;
}
function asRecord(value) {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : undefined;
}
function asList(value, keys) {
    if (Array.isArray(value)) {
        return value;
    }
    const record = asRecord(value);
    if (!record) {
        return [];
    }
    for (const key of keys) {
        if (Array.isArray(record[key])) {
            return record[key];
        }
    }
    return [];
}
function recipeImageUrl(recipe) {
    const values = [];
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
        const url = cdnUrlForImageValue(value);
        if (url) {
            return url;
        }
    }
    throw new HelloFreshApiError("api", "This recipe image is not on the HelloFresh CDN.");
}
function cdnUrlForImageValue(raw) {
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
function relativeImagePath(value) {
    if (!value.includes("://") && value.startsWith("/") && !value.startsWith("//")) {
        return value;
    }
    let url;
    try {
        url = new URL(value);
    }
    catch {
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
function helloFreshCdnUrl(value) {
    try {
        const url = new URL(value);
        return url.protocol === "https:" && url.hostname === "img.hellofresh.com";
    }
    catch {
        return false;
    }
}
function imageMimeType(header) {
    const mime = header?.split(";")[0]?.trim().toLowerCase() ?? "";
    if (!mime.startsWith("image/") || /\s/.test(mime)) {
        throw new HelloFreshApiError("api", "HelloFresh did not return an image.");
    }
    return mime;
}
function stringField(record, keys) {
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
function numberField(record, keys) {
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
function stringArray(value) {
    if (!Array.isArray(value)) {
        return undefined;
    }
    const items = value.filter((item) => typeof item === "string");
    return items;
}
function nestedString(record, path) {
    let current = record;
    for (const key of path) {
        const next = asRecord(current);
        if (!next) {
            return undefined;
        }
        current = next[key];
    }
    return typeof current === "string" ? current : undefined;
}
//# sourceMappingURL=hellofresh-api.js.map