import { type ParsedAuthBlob, type StoredAccount } from "./accounts.js";
import { type HelloFreshCountry } from "./countries.js";
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export type HelloFreshApiCode = "invalid_credentials" | "bot_blocked" | "rate_limited" | "reconnect_required" | "missing_email" | "invalid_token" | "unsupported" | "api";
export declare class HelloFreshApiError extends Error {
    readonly code: HelloFreshApiCode;
    constructor(code: HelloFreshApiCode, message: string);
}
export declare const RECONNECT_MESSAGE = "HelloFresh access expired. Disconnect the connector in Claude or ChatGPT and connect it again, then sign in on the authorize page. Do not send a password in chat.";
export declare const RATE_RECIPE_UNSUPPORTED = "rate_recipe is not available through the HelloFresh API this connector uses. Rate the recipe on the HelloFresh website.";
/** Shared across accounts. Recipe JSON is catalog data for a country and locale, not a user. */
export declare const RECIPE_DETAILS_TTL_MS: number;
export declare function clearRecipeDetailsCache(): void;
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
export declare class HelloFreshApi {
    private readonly fetchImpl;
    private readonly hooks;
    private readonly mutex;
    private account;
    readonly country: HelloFreshCountry;
    private reloginTried;
    /** Set when HelloFresh rejects the refresh token and password relogin cannot replace it. */
    private refreshRejected;
    constructor(account: StoredAccount, fetchImpl: FetchLike, hooks?: {
        onUpdate?: (account: StoredAccount) => Promise<void>;
        /** Stdio only. HTTP never supplies a password relogin. */
        relogin?: () => Promise<StoredAccount>;
    });
    get email(): string;
    static login(input: {
        email: string;
        password: string;
        country: string;
        fetchImpl?: FetchLike;
    }): Promise<HelloFreshApi>;
    static fromPasted(input: {
        token: string;
        country: string;
        fetchImpl?: FetchLike;
        parsed?: ParsedAuthBlob;
    }): Promise<HelloFreshApi>;
    toStoredAccount(): StoredAccount;
    status(): AccountStatus;
    getMenu(weekOffset?: number): Promise<{
        weekId: string;
        recipes: RecipeSummary[];
    }>;
    getRecipe(recipeId: string): Promise<Record<string, unknown>>;
    getRecipeImage(recipeId: string): Promise<RecipeImage>;
    /** Card fields for a recipe payload already loaded from HelloFresh. */
    recipeCard(recipe: Record<string, unknown>): RecipeCard;
    private loadRecipe;
    private fetchRecipe;
    private fetchPublicImage;
    selectMeals(weekId: string, meals: Array<{
        recipeId: string;
        quantity?: number;
    }>): Promise<Record<string, unknown>>;
    skipWeek(weekId: string): Promise<Record<string, unknown>>;
    getDeliveries(): Promise<DeliveryWeek[]>;
    modifyDelivery(weekId: string, newDate: string): Promise<Record<string, unknown>>;
    getPreferences(): Promise<Record<string, unknown>>;
    updatePreferences(changes: {
        vegetarian?: boolean;
        familyFriendly?: boolean;
        dietaryPreferences?: string[];
        allergens?: string[];
        cuisinePreferences?: string[];
    }): Promise<Record<string, unknown>>;
    getSubscription(): Promise<Record<string, unknown>>;
    modifySubscription(changes: {
        mealsPerWeek?: number;
        servingsPerMeal?: number;
        frequency?: "weekly" | "biweekly";
    }): Promise<Record<string, unknown>>;
    getPastOrders(limit: number): Promise<Array<Record<string, unknown>>>;
    private assertSubscriptions;
    private discoverEmail;
    private loadWeeks;
    private primarySubscription;
    private selectedMealsForWeek;
    private recipesForWeek;
    private enrichMenuNutrition;
    private patchDeliveryStatus;
    private deliveryOptions;
    private cartProductSku;
    private matchingProductHandle;
    private query;
    private profileParams;
    private accessExpiring;
    private getJson;
    private request;
    private refresh;
    private tryRelogin;
}
export declare function accountFromAuthPayload(payload: unknown, country: string, email: string, now: number): StoredAccount;
/** Public img.hellofresh.com URL, or undefined when the value is not a HelloFresh image. */
export declare function publicRecipeImageUrl(raw: string | undefined): string | undefined;
//# sourceMappingURL=hellofresh-api.d.ts.map