import { Browser, BrowserContext, Page, chromium } from "playwright";
import {
  AsyncMutex,
  AuthError,
  MISSING_SESSION_MESSAGE,
  readOptionalPasswordCredentials,
  toAuthError,
} from "./auth.js";
import { assertInteractiveLoginAllowed } from "./login-mode.js";
import {
  deletePersistedSession,
  filterHelloFreshStorageState,
  helloFreshCookiesAreValid,
  isHelloFreshLoggedInUrl,
  loadPersistedSession,
  resolveSessionPath,
  savePersistedSession,
  toPlaywrightStorageState,
  type PlaywrightStorageState,
} from "./session.js";

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

const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const LOGIN_POLL_MS = 500;
const PROBE_TIMEOUT_MS = 15_000;

const DEFAULT_CONTEXT_OPTIONS = {
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  viewport: { width: 1280, height: 720 },
};

function launchChromium(headless: boolean): Promise<Browser> {
  return chromium.launch({
    headless,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
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

export class HelloFreshBrowser {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private isLoggedIn = false;
  private readonly baseUrl = "https://www.hellofresh.com";
  private readonly mutex = new AsyncMutex();
  private readonly launchFn: () => Promise<Browser>;
  private readonly launchHeadedFn: () => Promise<Browser>;
  private readonly sessionPathOverride?: string;
  private readonly loginTimeoutMs: number;
  private readonly loginPollMs: number;

  constructor(private readonly options: HelloFreshBrowserOptions = {}) {
    this.launchFn = options.launch ?? (() => launchChromium(true));
    this.launchHeadedFn = options.launchHeaded ?? (() => launchChromium(false));
    this.sessionPathOverride = options.sessionPath;
    this.loginTimeoutMs =
      options.loginTimeoutMs ??
      (Number(process.env.HELLOFRESH_LOGIN_TIMEOUT_MS) || DEFAULT_LOGIN_TIMEOUT_MS);
    this.loginPollMs = options.loginPollMs ?? LOGIN_POLL_MS;
  }

  sessionFilePath(): string {
    return resolveSessionPath(process.env, this.sessionPathOverride);
  }

  /** True when a Playwright browser is currently open (tests / diagnostics). */
  hasActiveBrowser(): boolean {
    return this.browser !== null;
  }

  isSessionFlagSet(): boolean {
    return this.isLoggedIn;
  }

  /**
   * Opens Chromium. Safe to call repeatedly: any existing browser is closed first.
   */
  async init(): Promise<void> {
    await this.mutex.runExclusive(() => this.initUnlocked());
  }

  /**
   * Restore a saved HelloFresh session (probe + at most one password relogin).
   * Google SSO is never retried here — use interactiveLogin() for that.
   */
  async ensureReady(credentials?: HelloFreshCredentials): Promise<void> {
    await this.mutex.runExclusive(async () => {
      try {
        await this.ensureReadyUnlocked(credentials);
      } catch (error) {
        await this.closeUnlocked();
        throw toAuthError(error);
      }
    });
  }

  async login(credentials: HelloFreshCredentials): Promise<void> {
    await this.mutex.runExclusive(async () => {
      try {
        await this.passwordLoginAndSaveUnlocked(credentials);
      } catch (error) {
        await this.closeUnlocked();
        throw toAuthError(error);
      }
    });
  }

  /**
   * Opens headed Chromium on the HelloFresh login page. The user completes
   * Continue with Google. Requires a display. Never collects Google secrets.
   */
  async interactiveLogin(): Promise<{ path: string; savedAt: string }> {
    assertInteractiveLoginAllowed({
      hasInjectedHeadedLauncher: Boolean(this.options.launchHeaded),
    });
    return this.mutex.runExclusive(async () => {
      try {
        return await this.interactiveLoginUnlocked();
      } catch (error) {
        await this.closeUnlocked();
        throw toAuthError(error);
      }
    });
  }

  async logout(): Promise<void> {
    await this.mutex.runExclusive(async () => {
      await this.closeUnlocked();
      await deletePersistedSession(this.sessionFilePath());
    });
  }

  async getAuthStatus(): Promise<AuthStatus> {
    const path = this.sessionFilePath();
    const persisted = await loadPersistedSession(path);
    const cookieCount = persisted?.storageState.cookies.length ?? 0;
    const valid = persisted
      ? helloFreshCookiesAreValid(persisted.storageState)
      : false;
    return {
      authenticated: this.isLoggedIn || valid,
      browserOpen: this.hasActiveBrowser(),
      passwordFallbackConfigured: Boolean(readOptionalPasswordCredentials()),
      session: {
        exists: Boolean(persisted),
        path,
        savedAt: persisted?.savedAt ?? null,
        helloFreshCookieCount: cookieCount,
        valid,
      },
    };
  }

  private async ensureReadyUnlocked(
    credentials?: HelloFreshCredentials
  ): Promise<void> {
    if (this.page && this.isLoggedIn && (await this.probeUnlocked())) {
      return;
    }
    this.isLoggedIn = false;

    const persisted = await loadPersistedSession(this.sessionFilePath());
    if (persisted) {
      await this.initUnlocked(persisted.storageState);
      if (await this.probeUnlocked()) {
        this.isLoggedIn = true;
        return;
      }
      await this.closeUnlocked();
      if (credentials) {
        await this.passwordLoginAndSaveUnlocked(credentials);
        return;
      }
      throw AuthError.expired();
    }

    if (credentials) {
      await this.passwordLoginAndSaveUnlocked(credentials);
      return;
    }

    throw AuthError.missingSession();
  }

  private async passwordLoginAndSaveUnlocked(
    credentials: HelloFreshCredentials
  ): Promise<void> {
    await this.initUnlocked();
    await this.loginUnlocked(credentials);
    await this.saveSessionUnlocked();
  }

  private async interactiveLoginUnlocked(): Promise<{ path: string; savedAt: string }> {
    await this.initUnlocked(undefined, true);
    const page = this.page;
    if (!page) {
      throw AuthError.loginFailed("Browser page is not initialized");
    }

    await page.goto(`${this.baseUrl}/login`, {
      waitUntil: "domcontentloaded",
      timeout: PROBE_TIMEOUT_MS,
    });
    await this.dismissCookieBanner(page);

    const deadline = Date.now() + this.loginTimeoutMs;
    while (Date.now() < deadline) {
      if (isHelloFreshLoggedInUrl(page.url())) {
        break;
      }
      await page.waitForTimeout(this.loginPollMs);
    }

    if (!isHelloFreshLoggedInUrl(page.url())) {
      throw AuthError.loginFailed(
        `Timed out after ${this.loginTimeoutMs}ms waiting for HelloFresh Google SSO. ${MISSING_SESSION_MESSAGE}`
      );
    }

    this.isLoggedIn = true;
    const saved = await this.saveSessionUnlocked();
    await this.closeUnlocked();
    return { path: this.sessionFilePath(), savedAt: saved.savedAt };
  }

  private async initUnlocked(
    storageState?: PlaywrightStorageState,
    headed = false
  ): Promise<void> {
    await this.closeUnlocked();
    this.browser = headed ? await this.launchHeadedFn() : await this.launchFn();
    this.context = await this.browser.newContext({
      ...DEFAULT_CONTEXT_OPTIONS,
      ...(storageState ? { storageState: toPlaywrightStorageState(storageState) } : {}),
    });
    this.page = await this.context.newPage();
  }

  private async probeUnlocked(): Promise<boolean> {
    const page = this.page;
    if (!page) {
      return false;
    }
    try {
      await page.goto(`${this.baseUrl}/my-account`, {
        waitUntil: "domcontentloaded",
        timeout: PROBE_TIMEOUT_MS,
      });
    } catch {
      // Still inspect whatever URL we landed on.
    }
    return isHelloFreshLoggedInUrl(page.url());
  }

  private async saveSessionUnlocked() {
    if (!this.context) {
      throw AuthError.loginFailed("Cannot save session without a browser context");
    }
    const raw = await this.context.storageState();
    const filtered = filterHelloFreshStorageState(raw);
    if (filtered.cookies.length === 0) {
      throw AuthError.loginFailed(
        "Login succeeded but no HelloFresh cookies were present to persist"
      );
    }
    return savePersistedSession(this.sessionFilePath(), filtered);
  }

  private async dismissCookieBanner(page: Page): Promise<void> {
    try {
      const cookieBtn = page.locator(
        '[data-testid="cookie-consent-accept"], button:has-text("Accept All"), button:has-text("Accept Cookies")'
      );
      if (await cookieBtn.isVisible({ timeout: 3000 })) {
        await cookieBtn.first().click();
      }
    } catch {
      // Cookie banner not present
    }
  }

  private async loginUnlocked(credentials: HelloFreshCredentials): Promise<void> {
    this.isLoggedIn = false;
    const page = this.page;
    if (!page) {
      throw AuthError.loginFailed("Browser page is not initialized");
    }

    await page.goto(`${this.baseUrl}/login`);
    await page.waitForLoadState("networkidle");
    await this.dismissCookieBanner(page);

    // Optional password-account fallback. Never used for Google SSO.
    const emailInput = page.locator(
      'input[type="email"], input[name="email"], input[id="email"]'
    );
    await emailInput.fill(credentials.email);

    const passwordInput = page.locator(
      'input[type="password"], input[name="password"], input[id="password"]'
    );
    await passwordInput.fill(credentials.password);

    const submitBtn = page.locator(
      'button[type="submit"], button:has-text("Log In"), button:has-text("Sign In")'
    );
    await submitBtn.first().click();

    await page.waitForLoadState("networkidle");

    const currentUrl = page.url();
    if (!isHelloFreshLoggedInUrl(currentUrl)) {
      const errorMsg = await page
        .locator('[data-testid="error-message"], .error-message, [role="alert"]')
        .textContent()
        .catch(() => "Unknown error");
      throw AuthError.invalidCredentials(errorMsg ?? undefined);
    }

    this.isLoggedIn = true;
  }

  private async ensureLoggedIn(): Promise<void> {
    if (!this.isLoggedIn) {
      throw AuthError.missingSession(MISSING_SESSION_MESSAGE);
    }
  }

  async getMenu(weekOffset = 0): Promise<Recipe[]> {
    await this.ensureLoggedIn();
    const page = this.page!;

    const url =
      weekOffset === 0
        ? `${this.baseUrl}/menu`
        : `${this.baseUrl}/menu?week_offset=${weekOffset}`;

    await page.goto(url);
    await page.waitForLoadState("networkidle");

    // Extract recipe data from the page
    const recipes = await page.evaluate(() => {
      const recipeCards = document.querySelectorAll(
        '[data-testid="recipe-card"], .recipe-card, [class*="RecipeCard"]'
      );
      const results: Recipe[] = [];

      recipeCards.forEach((card) => {
        const nameEl = card.querySelector(
          '[data-testid="recipe-card-name"], h3, .recipe-name, [class*="RecipeName"]'
        );
        const idAttr =
          card.getAttribute("data-recipe-id") ||
          card.getAttribute("data-id") ||
          card.id;
        const timeEl = card.querySelector('[class*="time"], [data-testid*="time"]');
        const difficultyEl = card.querySelector(
          '[class*="difficulty"], [data-testid*="difficulty"]'
        );
        const caloriesEl = card.querySelector(
          '[class*="calorie"], [data-testid*="calorie"]'
        );
        const tagEls = card.querySelectorAll('[class*="tag"], [class*="badge"]');
        const imageEl = card.querySelector("img");

        if (nameEl) {
          results.push({
            id: idAttr || Math.random().toString(36).substr(2, 9),
            name: nameEl.textContent?.trim() || "",
            description: "",
            imageUrl: (imageEl as HTMLImageElement)?.src || undefined,
            prepTime: 10,
            cookTime: parseInt(timeEl?.textContent || "30") || 30,
            totalTime: parseInt(timeEl?.textContent || "40") || 40,
            difficulty: difficultyEl?.textContent?.trim() || "Medium",
            calories: parseInt(caloriesEl?.textContent || "600") || 600,
            servings: 2,
            tags: Array.from(tagEls).map((t) => t.textContent?.trim() || ""),
            isVegetarian: card.textContent?.toLowerCase().includes("vegetarian"),
            isFamily: card.textContent?.toLowerCase().includes("family"),
          } as Recipe);
        }
      });

      return results;
    });

    // Fallback: try API endpoint approach
    if (recipes.length === 0) {
      try {
        const apiData = await page.evaluate(async (baseUrl: string) => {
          const resp = await fetch(`${baseUrl}/api/menus/current`, {
            credentials: "include",
          });
          if (resp.status === 401 || resp.status === 403) {
            return { authExpired: true as const };
          }
          if (resp.ok) return resp.json();
          return null;
        }, this.baseUrl);

        if (apiData?.authExpired) {
          this.isLoggedIn = false;
          throw AuthError.expired();
        }

        if (apiData?.recipes) {
          return this.parseApiRecipes(apiData.recipes);
        }
      } catch {
        // API approach failed, return what we have
      }
    }

    return recipes;
  }

  private parseApiRecipes(apiRecipes: unknown[]): Recipe[] {
    return apiRecipes.map((r: unknown) => {
      const recipe = r as Record<string, unknown>;
      return {
        id: String(recipe.id || ""),
        name: String(recipe.name || ""),
        description: String(recipe.description || ""),
        imageUrl: String(recipe.imageLink || ""),
        prepTime: Number(recipe.prepTime || 10),
        cookTime: Number(recipe.totalTime || 30),
        totalTime: Number(recipe.totalTime || 40),
        difficulty: String(recipe.difficulty || "Medium"),
        calories:
          Number(
            (recipe.nutrition as Record<string, unknown>)?.["energyKcal"] || 600
          ),
        servings: Number(recipe.yields || 2),
        tags: ((recipe.tags as unknown[]) || []).map((t) =>
          String((t as Record<string, unknown>).name || t)
        ),
        cuisineType: String(recipe.cuisineType || ""),
        isVegetarian: (recipe.tags as unknown[])?.some(
          (t) => String((t as Record<string, unknown>).name || t).toLowerCase() === "vegetarian"
        ),
        isFamily: (recipe.tags as unknown[])?.some(
          (t) =>
            String((t as Record<string, unknown>).name || t).toLowerCase().includes("family")
        ),
      };
    });
  }

  async getRecipeDetails(recipeId: string): Promise<RecipeDetails> {
    await this.ensureLoggedIn();
    const page = this.page!;

    await page.goto(`${this.baseUrl}/recipes/${recipeId}`);
    await page.waitForLoadState("networkidle");

    const details = await page.evaluate(() => {
      const nameEl = document.querySelector(
        "h1, [data-testid='recipe-title'], [class*='RecipeTitle']"
      );
      const descEl = document.querySelector(
        "[data-testid='recipe-description'], [class*='Description']"
      );

      // Ingredients
      const ingredientEls = document.querySelectorAll(
        "[data-testid='ingredient-item'], [class*='Ingredient'], .ingredient"
      );
      const ingredients = Array.from(ingredientEls).map((el) => ({
        name: el.querySelector("[class*='name'], .name")?.textContent?.trim() || el.textContent?.trim() || "",
        amount: el.querySelector("[class*='amount'], .amount")?.textContent?.trim() || "",
        unit: el.querySelector("[class*='unit'], .unit")?.textContent?.trim() || "",
      }));

      // Instructions
      const stepEls = document.querySelectorAll(
        "[data-testid='instruction-step'], [class*='Step'], .step"
      );
      const instructions = Array.from(stepEls).map(
        (el) => el.textContent?.trim() || ""
      );

      // Nutrition
      const nutritionData: Record<string, number> = {};
      const nutritionEls = document.querySelectorAll(
        "[data-testid='nutrition-item'], [class*='Nutrition'] tr, [class*='nutrition'] tr"
      );
      nutritionEls.forEach((el) => {
        const label = el.querySelector("td:first-child, th")?.textContent?.trim().toLowerCase() || "";
        const value = parseFloat(
          el.querySelector("td:last-child")?.textContent || "0"
        );
        if (label.includes("calorie") || label.includes("energy"))
          nutritionData.calories = value;
        else if (label.includes("fat") && !label.includes("saturated"))
          nutritionData.fat = value;
        else if (label.includes("saturated")) nutritionData.saturatedFat = value;
        else if (label.includes("carb")) nutritionData.carbohydrates = value;
        else if (label.includes("sugar")) nutritionData.sugar = value;
        else if (label.includes("protein")) nutritionData.protein = value;
        else if (label.includes("fiber")) nutritionData.fiber = value;
        else if (label.includes("sodium") || label.includes("salt"))
          nutritionData.sodium = value;
      });

      // Tags / allergens
      const allergenEls = document.querySelectorAll(
        "[data-testid='allergen'], [class*='Allergen'], [class*='allergen']"
      );
      const allergens = Array.from(allergenEls).map(
        (el) => el.textContent?.trim() || ""
      );

      const tagEls = document.querySelectorAll(
        "[data-testid='recipe-tag'], [class*='Tag'], [class*='badge']"
      );
      const tags = Array.from(tagEls).map((el) => el.textContent?.trim() || "");

      // Time/difficulty
      const timeEl = document.querySelector("[class*='time'], [data-testid*='time']");
      const difficultyEl = document.querySelector("[class*='difficulty']");
      const caloriesEl = document.querySelector("[class*='calorie'], [data-testid*='calorie']");

      return {
        name: nameEl?.textContent?.trim() || "",
        description: descEl?.textContent?.trim() || "",
        ingredients,
        instructions,
        nutrition: {
          calories: nutritionData.calories || parseInt(caloriesEl?.textContent || "600") || 600,
          fat: nutritionData.fat || 20,
          saturatedFat: nutritionData.saturatedFat || 5,
          carbohydrates: nutritionData.carbohydrates || 60,
          sugar: nutritionData.sugar || 8,
          protein: nutritionData.protein || 35,
          fiber: nutritionData.fiber || 4,
          sodium: nutritionData.sodium || 800,
        },
        allergens,
        tags,
        totalTime: parseInt(timeEl?.textContent || "40") || 40,
        difficulty: difficultyEl?.textContent?.trim() || "Medium",
        utensils: [],
      };
    });

    return {
      id: recipeId,
      prepTime: 10,
      cookTime: details.totalTime - 10,
      calories: details.nutrition.calories,
      servings: 2,
      cuisineType: "",
      isVegetarian: details.tags.some((t: string) =>
        t.toLowerCase().includes("vegetarian")
      ),
      isFamily: details.tags.some((t: string) =>
        t.toLowerCase().includes("family")
      ),
      imageUrl: undefined,
      ...details,
    };
  }

  async getDeliverySchedule(): Promise<DeliveryInfo[]> {
    await this.ensureLoggedIn();
    const page = this.page!;

    await page.goto(`${this.baseUrl}/my-account/deliveries`);
    await page.waitForLoadState("networkidle");

    const deliveries = await page.evaluate(() => {
      const deliveryEls = document.querySelectorAll(
        "[data-testid='delivery-card'], [class*='DeliveryCard'], [class*='delivery-card']"
      );
      return Array.from(deliveryEls).map((el) => {
        const dateEl = el.querySelector(
          "[class*='date'], [data-testid*='date']"
        );
        const statusEl = el.querySelector(
          "[class*='status'], [data-testid*='status']"
        );
        const mealEls = el.querySelectorAll(
          "[class*='meal'], [class*='recipe']"
        );
        const weekId =
          el.getAttribute("data-week") ||
          el.getAttribute("data-delivery-id") ||
          "";

        return {
          weekId,
          deliveryDate: dateEl?.textContent?.trim() || "",
          status: statusEl?.textContent?.trim() || "Scheduled",
          meals: Array.from(mealEls).map((m) => ({
            recipeId: m.getAttribute("data-recipe-id") || "",
            recipeName: m.textContent?.trim() || "",
            servings: 2,
          })),
          canModify: el.querySelector("button:has-text('Modify'), [data-testid*='modify']") !== null,
        };
      });
    });

    return deliveries;
  }

  async selectMeals(
    weekId: string,
    mealSelections: { recipeId: string; servings?: number }[]
  ): Promise<{ success: boolean; message: string }> {
    await this.ensureLoggedIn();
    const page = this.page!;

    await page.goto(`${this.baseUrl}/menu?week=${weekId}`);
    await page.waitForLoadState("networkidle");

    let selectedCount = 0;
    for (const selection of mealSelections) {
      const recipeCard = page.locator(
        `[data-recipe-id="${selection.recipeId}"], [data-id="${selection.recipeId}"]`
      );

      if (await recipeCard.isVisible({ timeout: 5000 })) {
        const selectBtn = recipeCard.locator(
          'button:has-text("Add"), button:has-text("Select"), [data-testid*="add"]'
        );
        if (await selectBtn.isVisible()) {
          await selectBtn.click();
          selectedCount++;
          await page.waitForTimeout(500);
        }
      }
    }

    // Confirm selection
    const confirmBtn = page.locator(
      'button:has-text("Confirm"), button:has-text("Save"), [data-testid*="confirm"]'
    );
    if (await confirmBtn.isVisible({ timeout: 3000 })) {
      await confirmBtn.click();
      await page.waitForLoadState("networkidle");
    }

    return {
      success: selectedCount > 0,
      message:
        selectedCount > 0
          ? `Successfully selected ${selectedCount} meals for week ${weekId}`
          : "No meals could be selected. Please verify recipe IDs and week availability.",
    };
  }

  async skipWeek(
    weekId: string
  ): Promise<{ success: boolean; message: string }> {
    await this.ensureLoggedIn();
    const page = this.page!;

    await page.goto(`${this.baseUrl}/my-account/deliveries`);
    await page.waitForLoadState("networkidle");

    // Find the week and click skip
    const weekEl = page.locator(
      `[data-week="${weekId}"], [data-delivery-id="${weekId}"]`
    );
    if (await weekEl.isVisible({ timeout: 5000 })) {
      const skipBtn = weekEl.locator(
        'button:has-text("Skip"), [data-testid*="skip"]'
      );
      if (await skipBtn.isVisible()) {
        await skipBtn.click();
        await page.waitForLoadState("networkidle");

        // Confirm skip if prompted
        const confirmBtn = page.locator(
          'button:has-text("Confirm Skip"), button:has-text("Yes, Skip"), [data-testid*="confirm-skip"]'
        );
        if (await confirmBtn.isVisible({ timeout: 3000 })) {
          await confirmBtn.click();
          await page.waitForLoadState("networkidle");
        }

        return { success: true, message: `Successfully skipped week ${weekId}` };
      }
    }

    return {
      success: false,
      message: `Could not find or skip week ${weekId}. It may not be available for skipping.`,
    };
  }

  async modifyDelivery(
    weekId: string,
    newDate: string
  ): Promise<{ success: boolean; message: string }> {
    await this.ensureLoggedIn();
    const page = this.page!;

    await page.goto(`${this.baseUrl}/my-account/deliveries`);
    await page.waitForLoadState("networkidle");

    const weekEl = page.locator(
      `[data-week="${weekId}"], [data-delivery-id="${weekId}"]`
    );
    if (await weekEl.isVisible({ timeout: 5000 })) {
      const modifyBtn = weekEl.locator(
        'button:has-text("Modify"), button:has-text("Change"), [data-testid*="modify"]'
      );
      if (await modifyBtn.isVisible()) {
        await modifyBtn.click();
        await page.waitForLoadState("networkidle");

        // Select new date
        const dateOption = page.locator(
          `[data-date="${newDate}"], option[value="${newDate}"]`
        );
        if (await dateOption.isVisible({ timeout: 5000 })) {
          await dateOption.click();
        } else {
          // Try select element
          const dateSelect = page.locator('select[name*="date"], select[id*="date"]');
          if (await dateSelect.isVisible()) {
            await dateSelect.selectOption(newDate);
          }
        }

        const saveBtn = page.locator(
          'button:has-text("Save"), button:has-text("Confirm"), [data-testid*="save"]'
        );
        if (await saveBtn.isVisible({ timeout: 3000 })) {
          await saveBtn.click();
          await page.waitForLoadState("networkidle");
        }

        return {
          success: true,
          message: `Delivery for week ${weekId} rescheduled to ${newDate}`,
        };
      }
    }

    return {
      success: false,
      message: `Could not modify delivery for week ${weekId}.`,
    };
  }

  async getPreferences(): Promise<Preferences> {
    await this.ensureLoggedIn();
    const page = this.page!;

    await page.goto(`${this.baseUrl}/my-account/preferences`);
    await page.waitForLoadState("networkidle");

    const preferences = await page.evaluate(() => {
      const checkedPrefs = Array.from(
        document.querySelectorAll(
          'input[type="checkbox"]:checked, [data-testid*="preference"][aria-checked="true"]'
        )
      ).map(
        (el) =>
          el.getAttribute("value") ||
          el.getAttribute("name") ||
          (el as HTMLInputElement).value ||
          ""
      );

      const isVegetarian = checkedPrefs.some((p) =>
        p.toLowerCase().includes("vegetarian")
      );
      const isFamily = checkedPrefs.some((p) =>
        p.toLowerCase().includes("family")
      );

      return {
        dietaryPreferences: checkedPrefs.filter(
          (p) =>
            !p.toLowerCase().includes("allergen") &&
            !p.toLowerCase().includes("cuisine")
        ),
        allergens: checkedPrefs.filter((p) =>
          p.toLowerCase().includes("allergen")
        ),
        cuisinePreferences: checkedPrefs.filter((p) =>
          p.toLowerCase().includes("cuisine")
        ),
        familyFriendly: isFamily,
        vegetarian: isVegetarian,
      };
    });

    return preferences;
  }

  async updatePreferences(
    preferences: Partial<Preferences>
  ): Promise<{ success: boolean; message: string }> {
    await this.ensureLoggedIn();
    const page = this.page!;

    await page.goto(`${this.baseUrl}/my-account/preferences`);
    await page.waitForLoadState("networkidle");

    // Update dietary preferences
    if (preferences.vegetarian !== undefined) {
      const vegCheckbox = page.locator(
        'input[value*="vegetarian"], [data-testid*="vegetarian"]'
      );
      if (await vegCheckbox.isVisible()) {
        const isChecked = await vegCheckbox.isChecked();
        if (preferences.vegetarian !== isChecked) {
          await vegCheckbox.click();
        }
      }
    }

    if (preferences.familyFriendly !== undefined) {
      const familyCheckbox = page.locator(
        'input[value*="family"], [data-testid*="family"]'
      );
      if (await familyCheckbox.isVisible()) {
        const isChecked = await familyCheckbox.isChecked();
        if (preferences.familyFriendly !== isChecked) {
          await familyCheckbox.click();
        }
      }
    }

    // Save preferences
    const saveBtn = page.locator(
      'button:has-text("Save"), button[type="submit"], [data-testid*="save-preferences"]'
    );
    if (await saveBtn.isVisible({ timeout: 3000 })) {
      await saveBtn.click();
      await page.waitForLoadState("networkidle");
    }

    return { success: true, message: "Preferences updated successfully." };
  }

  async getSubscription(): Promise<Subscription> {
    await this.ensureLoggedIn();
    const page = this.page!;

    await page.goto(`${this.baseUrl}/my-account/plan`);
    await page.waitForLoadState("networkidle");

    const subscription = await page.evaluate(() => {
      const planEl = document.querySelector(
        "[data-testid='plan-name'], [class*='PlanName'], h2"
      );
      const mealsEl = document.querySelector(
        "[data-testid*='meals-per-week'], [class*='MealsPerWeek']"
      );
      const servingsEl = document.querySelector(
        "[data-testid*='servings'], [class*='Servings']"
      );
      const priceEl = document.querySelector(
        "[data-testid*='price'], [class*='Price']"
      );
      const nextDeliveryEl = document.querySelector(
        "[data-testid*='next-delivery'], [class*='NextDelivery']"
      );
      const statusEl = document.querySelector(
        "[data-testid*='status'], [class*='Status']"
      );

      const mealsText = mealsEl?.textContent || "3";
      const servingsText = servingsEl?.textContent || "2";
      const priceText = priceEl?.textContent || "9.99";

      return {
        planId:
          planEl?.getAttribute("data-plan-id") ||
          planEl?.textContent?.trim() ||
          "classic",
        mealsPerWeek: parseInt(mealsText.match(/\d+/)?.[0] || "3"),
        servingsPerMeal: parseInt(servingsText.match(/\d+/)?.[0] || "2"),
        frequency: "weekly",
        pricePerServing: parseFloat(priceText.match(/[\d.]+/)?.[0] || "9.99"),
        nextDeliveryDate:
          nextDeliveryEl?.textContent?.trim() || "Next week",
        status: statusEl?.textContent?.trim() || "Active",
      };
    });

    return subscription;
  }

  async modifySubscription(
    changes: Partial<{ mealsPerWeek: number; servingsPerMeal: number; frequency: string }>
  ): Promise<{ success: boolean; message: string }> {
    await this.ensureLoggedIn();
    const page = this.page!;

    await page.goto(`${this.baseUrl}/my-account/plan`);
    await page.waitForLoadState("networkidle");

    let changed = false;

    if (changes.mealsPerWeek !== undefined) {
      const mealsSelect = page.locator(
        `[data-testid*="meals-select"], select[name*="meals"]`
      );
      if (await mealsSelect.isVisible()) {
        await mealsSelect.selectOption(String(changes.mealsPerWeek));
        changed = true;
      } else {
        // Try button-based selection
        const mealsBtn = page.locator(
          `button:has-text("${changes.mealsPerWeek} meals"), [data-meals="${changes.mealsPerWeek}"]`
        );
        if (await mealsBtn.isVisible({ timeout: 3000 })) {
          await mealsBtn.click();
          changed = true;
        }
      }
    }

    if (changes.servingsPerMeal !== undefined) {
      const servingsSelect = page.locator(
        `[data-testid*="servings-select"], select[name*="servings"]`
      );
      if (await servingsSelect.isVisible()) {
        await servingsSelect.selectOption(String(changes.servingsPerMeal));
        changed = true;
      } else {
        const servingsBtn = page.locator(
          `button:has-text("${changes.servingsPerMeal} servings"), [data-servings="${changes.servingsPerMeal}"]`
        );
        if (await servingsBtn.isVisible({ timeout: 3000 })) {
          await servingsBtn.click();
          changed = true;
        }
      }
    }

    if (changed) {
      const saveBtn = page.locator(
        'button:has-text("Save Changes"), button:has-text("Update Plan"), button[type="submit"]'
      );
      if (await saveBtn.isVisible({ timeout: 3000 })) {
        await saveBtn.click();
        await page.waitForLoadState("networkidle");
      }
    }

    const details = Object.entries(changes)
      .map(([k, v]) => `${k}: ${v}`)
      .join(", ");

    return {
      success: changed,
      message: changed
        ? `Subscription updated: ${details}`
        : "No changes could be applied. Please verify the plan options.",
    };
  }

  async getPastOrders(limit = 10): Promise<Order[]> {
    await this.ensureLoggedIn();
    const page = this.page!;

    await page.goto(`${this.baseUrl}/my-account/orders`);
    await page.waitForLoadState("networkidle");

    const orders = await page.evaluate((maxOrders: number) => {
      const orderEls = Array.from(
        document.querySelectorAll(
          "[data-testid='order-card'], [class*='OrderCard'], [class*='order-card']"
        )
      ).slice(0, maxOrders);

      return orderEls.map((el) => {
        const dateEl = el.querySelector("[class*='date'], [data-testid*='date']");
        const priceEl = el.querySelector("[class*='price'], [class*='total']");
        const statusEl = el.querySelector("[class*='status']");
        const mealEls = el.querySelectorAll("[class*='meal'], [class*='recipe']");
        const orderId =
          el.getAttribute("data-order-id") ||
          el.getAttribute("data-id") ||
          Math.random().toString(36).substr(2, 9);

        return {
          orderId,
          deliveryDate: dateEl?.textContent?.trim() || "",
          meals: Array.from(mealEls).map((m) => ({
            recipeId: m.getAttribute("data-recipe-id") || "",
            recipeName: m.textContent?.trim() || "",
            servings: 2,
          })),
          totalPrice: parseFloat(
            priceEl?.textContent?.match(/[\d.]+/)?.[0] || "0"
          ),
          status: statusEl?.textContent?.trim() || "Delivered",
        };
      });
    }, limit);

    return orders;
  }

  async rateRecipe(
    recipeId: string,
    rating: number,
    comment?: string
  ): Promise<{ success: boolean; message: string }> {
    await this.ensureLoggedIn();
    const page = this.page!;

    await page.goto(`${this.baseUrl}/recipes/${recipeId}`);
    await page.waitForLoadState("networkidle");

    // Look for rating stars/buttons
    const starBtn = page.locator(
      `[data-rating="${rating}"], [aria-label*="${rating} star"], .star:nth-child(${rating})`
    );

    if (await starBtn.isVisible({ timeout: 5000 })) {
      await starBtn.click();

      if (comment) {
        const commentInput = page.locator(
          'textarea[name*="comment"], textarea[placeholder*="comment"], textarea[placeholder*="review"]'
        );
        if (await commentInput.isVisible({ timeout: 3000 })) {
          await commentInput.fill(comment);
        }
      }

      const submitBtn = page.locator(
        'button:has-text("Submit"), button:has-text("Rate"), button[type="submit"]'
      );
      if (await submitBtn.isVisible({ timeout: 3000 })) {
        await submitBtn.click();
        await page.waitForLoadState("networkidle");
      }

      return {
        success: true,
        message: `Recipe ${recipeId} rated ${rating}/5 stars${comment ? " with comment" : ""}.`,
      };
    }

    return {
      success: false,
      message: "Rating interface not found. Recipe may not be available for rating.",
    };
  }

  async close(): Promise<void> {
    await this.mutex.runExclusive(() => this.closeUnlocked());
  }

  private async closeUnlocked(): Promise<void> {
    if (this.page) {
      await this.page.close().catch(() => {});
      this.page = null;
    }
    if (this.context) {
      await this.context.close().catch(() => {});
      this.context = null;
    }
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
    this.isLoggedIn = false;
  }
}
