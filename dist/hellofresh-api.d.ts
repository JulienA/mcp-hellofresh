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
export interface RecipeSummary {
    id: string;
    name: string;
    description: string;
    imageUrl?: string;
    prepTime: number;
    tags: string[];
    index?: number;
}
export interface AccountStatus {
    authenticated: boolean;
    email: string | null;
    country: string | null;
    accessTokenValid: boolean;
    savedAt: string | null;
    reconnectRequired: boolean;
}
export interface DeliveryWeek {
    weekId: string;
    deliveryDate?: string;
    cutoffDate?: string;
    status?: string;
    subscriptionId?: string;
    sku?: string;
}
export declare class HelloFreshApi {
    private readonly fetchImpl;
    private readonly hooks;
    private readonly mutex;
    private account;
    readonly country: HelloFreshCountry;
    private reloginTried;
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
    selectMeals(weekId: string, meals: Array<{
        recipeId: string;
        servings?: number;
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
    private recipesForWeek;
    private patchDeliveryStatus;
    private deliveryOptions;
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
//# sourceMappingURL=hellofresh-api.d.ts.map