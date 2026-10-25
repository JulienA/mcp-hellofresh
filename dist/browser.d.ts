import { Browser } from "playwright";
export interface HelloFreshCredentials {
    email: string;
    password: string;
}
export interface HelloFreshBrowserOptions {
    /** Injected in tests. Production launches headless Chromium via Playwright. */
    launch?: () => Promise<Browser>;
    /** Headed Chromium for interactive Google SSO. Requires a display. */
    launchHeaded?: () => Promise<Browser>;
    /** Override session file path (tests / HELLOFRESH_SESSION_PATH). */
    sessionPath?: string;
    /** How long interactive Google SSO may take. */
    loginTimeoutMs?: number;
    /** Poll interval while waiting for Google SSO (tests). */
    loginPollMs?: number;
}
export interface AuthStatus {
    authenticated: boolean;
    browserOpen: boolean;
    passwordFallbackConfigured: boolean;
    session: {
        exists: boolean;
        path: string;
        savedAt: string | null;
        helloFreshCookieCount: number;
        valid: boolean;
    };
}
export interface Recipe {
    id: string;
    name: string;
    description: string;
    imageUrl?: string;
    prepTime: number;
    cookTime: number;
    totalTime: number;
    difficulty: string;
    calories: number;
    servings: number;
    tags: string[];
    cuisineType?: string;
    isVegetarian?: boolean;
    isFamily?: boolean;
}
export interface RecipeDetails extends Recipe {
    ingredients: Ingredient[];
    instructions: string[];
    nutrition: NutritionInfo;
    allergens: string[];
    utensils: string[];
}
export interface Ingredient {
    name: string;
    amount: string;
    unit: string;
}
export interface NutritionInfo {
    calories: number;
    fat: number;
    saturatedFat: number;
    carbohydrates: number;
    sugar: number;
    protein: number;
    fiber: number;
    sodium: number;
}
export interface DeliveryInfo {
    weekId: string;
    deliveryDate: string;
    status: string;
    meals: SelectedMeal[];
    canModify: boolean;
}
export interface SelectedMeal {
    recipeId: string;
    recipeName: string;
    servings: number;
}
export interface Preferences {
    dietaryPreferences: string[];
    allergens: string[];
    cuisinePreferences: string[];
    familyFriendly: boolean;
    vegetarian: boolean;
    calorieGoal?: number;
}
export interface Subscription {
    planId: string;
    mealsPerWeek: number;
    servingsPerMeal: number;
    frequency: string;
    pricePerServing: number;
    nextDeliveryDate: string;
    status: string;
}
export interface Order {
    orderId: string;
    deliveryDate: string;
    meals: SelectedMeal[];
    totalPrice: number;
    status: string;
}
export declare class HelloFreshBrowser {
    private readonly options;
    private browser;
    private context;
    private page;
    private isLoggedIn;
    private readonly baseUrl;
    private readonly mutex;
    private readonly launchFn;
    private readonly launchHeadedFn;
    private readonly sessionPathOverride?;
    private readonly loginTimeoutMs;
    private readonly loginPollMs;
    constructor(options?: HelloFreshBrowserOptions);
    sessionFilePath(): string;
    /** True when a Playwright browser is currently open (tests / diagnostics). */
    hasActiveBrowser(): boolean;
    isSessionFlagSet(): boolean;
    /**
     * Opens Chromium. Safe to call repeatedly: any existing browser is closed first.
     */
    init(): Promise<void>;
    /**
     * Restore a saved HelloFresh session (probe + at most one password relogin).
     * Google SSO is never retried here — use interactiveLogin() for that.
     */
    ensureReady(credentials?: HelloFreshCredentials): Promise<void>;
    login(credentials: HelloFreshCredentials): Promise<void>;
    /**
     * Opens headed Chromium on the HelloFresh login page. The user completes
     * Continue with Google. Requires a display. Never collects Google secrets.
     */
    interactiveLogin(): Promise<{
        path: string;
        savedAt: string;
    }>;
    logout(): Promise<void>;
    getAuthStatus(): Promise<AuthStatus>;
    private ensureReadyUnlocked;
    private passwordLoginAndSaveUnlocked;
    private interactiveLoginUnlocked;
    private initUnlocked;
    private probeUnlocked;
    private saveSessionUnlocked;
    private dismissCookieBanner;
    private loginUnlocked;
    private ensureLoggedIn;
    getMenu(weekOffset?: number): Promise<Recipe[]>;
    private parseApiRecipes;
    getRecipeDetails(recipeId: string): Promise<RecipeDetails>;
    getDeliverySchedule(): Promise<DeliveryInfo[]>;
    selectMeals(weekId: string, mealSelections: {
        recipeId: string;
        servings?: number;
    }[]): Promise<{
        success: boolean;
        message: string;
    }>;
    skipWeek(weekId: string): Promise<{
        success: boolean;
        message: string;
    }>;
    modifyDelivery(weekId: string, newDate: string): Promise<{
        success: boolean;
        message: string;
    }>;
    getPreferences(): Promise<Preferences>;
    updatePreferences(preferences: Partial<Preferences>): Promise<{
        success: boolean;
        message: string;
    }>;
    getSubscription(): Promise<Subscription>;
    modifySubscription(changes: Partial<{
        mealsPerWeek: number;
        servingsPerMeal: number;
        frequency: string;
    }>): Promise<{
        success: boolean;
        message: string;
    }>;
    getPastOrders(limit?: number): Promise<Order[]>;
    rateRecipe(recipeId: string, rating: number, comment?: string): Promise<{
        success: boolean;
        message: string;
    }>;
    close(): Promise<void>;
    private closeUnlocked;
}
//# sourceMappingURL=browser.d.ts.map