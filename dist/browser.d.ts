import { Browser } from "playwright";
export interface HelloFreshCredentials {
    email: string;
    password: string;
}
export interface HelloFreshBrowserOptions {
    /** Injected in tests. Production launches headed-capable Chromium via Playwright. */
    launch?: () => Promise<Browser>;
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
    private browser;
    private context;
    private page;
    private isLoggedIn;
    private readonly baseUrl;
    private readonly mutex;
    private readonly launchFn;
    constructor(options?: HelloFreshBrowserOptions);
    /** True when a Playwright browser is currently open (tests / diagnostics). */
    hasActiveBrowser(): boolean;
    isSessionFlagSet(): boolean;
    /**
     * Opens Chromium. Safe to call repeatedly: any existing browser is closed first.
     */
    init(): Promise<void>;
    /**
     * Session entry point: optional password fallback only.
     * Google SSO credentials must never be passed here — interactive login is a later step.
     */
    ensureReady(credentials?: HelloFreshCredentials): Promise<void>;
    login(credentials: HelloFreshCredentials): Promise<void>;
    private initUnlocked;
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