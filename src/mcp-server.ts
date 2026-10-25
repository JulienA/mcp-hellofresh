import { Server, type Tool } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import {
  formatAuthToolError,
  LOGIN_WINDOW_MESSAGE,
  readOptionalPasswordCredentials,
} from "./auth.js";
import { HelloFreshBrowser } from "./browser.js";
import { assertInteractiveLoginAllowed } from "./login-mode.js";

export interface HelloFreshMCPServerOptions {
  /** False for HTTP/headless deployments — the login tool must not open a browser. */
  allowInteractiveLogin?: boolean;
}

const AUTH_TOOL_NAMES = new Set(["auth_status", "login", "logout"]);

// ─── Schemas ──────────────────────────────────────────────────────────────────

const GetMenuSchema = z.object({
  week_offset: z
    .int()
    .min(0)
    .max(4)
    .optional()
    .default(0)
    .describe("Week offset from current week (0 = current, 1 = next week, etc.)"),
});

const GetRecipeDetailsSchema = z.object({
  recipe_id: z.string().describe("The unique recipe identifier"),
});

const SelectMealsSchema = z.object({
  week_id: z
    .string()
    .describe("The week identifier (e.g. '2024-W01') for the delivery"),
  meals: z
    .array(
      z.object({
        recipe_id: z.string().describe("Recipe ID to select"),
        servings: z
          .int()
          .min(1)
          .max(6)
          .optional()
          .describe("Number of servings (defaults to subscription default)"),
      })
    )
    .min(1)
    .describe("List of meals to select"),
});

const SkipWeekSchema = z.object({
  week_id: z.string().describe("The week identifier to skip (e.g. '2024-W01')"),
});

const ModifyDeliverySchema = z.object({
  week_id: z.string().describe("The week identifier for the delivery to modify"),
  new_date: z
    .string()
    .describe("New delivery date in YYYY-MM-DD format"),
});

const UpdatePreferencesSchema = z.object({
  vegetarian: z
    .boolean()
    .optional()
    .describe("Enable/disable vegetarian meal preference"),
  family_friendly: z
    .boolean()
    .optional()
    .describe("Enable/disable family-friendly meals"),
  dietary_preferences: z
    .array(z.string())
    .optional()
    .describe("List of dietary preferences to set"),
  allergens: z
    .array(z.string())
    .optional()
    .describe("List of allergens to avoid"),
  cuisine_preferences: z
    .array(z.string())
    .optional()
    .describe("Preferred cuisine types"),
});

const ModifySubscriptionSchema = z.object({
  meals_per_week: z
    .int()
    .min(2)
    .max(5)
    .optional()
    .describe("Number of meals per week (2-5)"),
  servings_per_meal: z
    .int()
    .min(2)
    .max(4)
    .optional()
    .describe("Number of servings per meal (2-4)"),
  frequency: z
    .enum(["weekly", "biweekly"])
    .optional()
    .describe("Delivery frequency"),
});

const GetPastOrdersSchema = z.object({
  limit: z
    .int()
    .min(1)
    .max(50)
    .optional()
    .default(10)
    .describe("Maximum number of past orders to retrieve"),
});

const RateRecipeSchema = z.object({
  recipe_id: z.string().describe("The recipe ID to rate"),
  rating: z
    .int()
    .min(1)
    .max(5)
    .describe("Rating from 1 (poor) to 5 (excellent)"),
  comment: z
    .string()
    .max(500)
    .optional()
    .describe("Optional written review/comment"),
});

// ─── Tool Definitions ─────────────────────────────────────────────────────────

const TOOLS: Tool[] = [
  {
    name: "auth_status",
    description:
      "Show whether a HelloFresh session file exists, whether its cookies look valid, and when it was saved. Does not return cookie values. Google SSO users should run login if valid is false.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "login",
    description:
      "Open a headed Chromium window on the HelloFresh login page so you can complete Continue with Google yourself. Requires a display. Not available in HTTP/headless mode — run `npm run login` on a machine with a screen and copy session.json (HELLOFRESH_SESSION_PATH). Never send Google passwords to this tool.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "logout",
    description:
      "Delete the saved HelloFresh session file and close the browser. Does not sign you out of Google.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "get_menu",
    description:
      "Get the current week's available recipes/meals from HelloFresh. Optionally specify a week offset to see future menus.",
    inputSchema: {
      type: "object",
      properties: {
        week_offset: {
          type: "integer",
          description:
            "Week offset from current week (0 = current, 1 = next week, etc.)",
          default: 0,
          minimum: 0,
          maximum: 4,
        },
      },
    },
  },
  {
    name: "get_recipe_details",
    description:
      "Get full recipe information including ingredients, step-by-step instructions, nutrition facts, prep time, and allergen information.",
    inputSchema: {
      type: "object",
      properties: {
        recipe_id: {
          type: "string",
          description: "The unique recipe identifier",
        },
      },
      required: ["recipe_id"],
    },
  },
  {
    name: "select_meals",
    description:
      "Choose specific meals for an upcoming delivery week. You can select multiple recipes by their IDs.",
    inputSchema: {
      type: "object",
      properties: {
        week_id: {
          type: "string",
          description: "The week identifier (e.g. '2024-W01') for the delivery",
        },
        meals: {
          type: "array",
          description: "List of meals to select",
          items: {
            type: "object",
            properties: {
              recipe_id: { type: "string", description: "Recipe ID to select" },
              servings: {
                type: "integer",
                description: "Number of servings (optional)",
                minimum: 1,
                maximum: 6,
              },
            },
            required: ["recipe_id"],
          },
          minItems: 1,
        },
      },
      required: ["week_id", "meals"],
    },
  },
  {
    name: "skip_week",
    description:
      "Skip a delivery week so you won't receive or be charged for that week's box.",
    inputSchema: {
      type: "object",
      properties: {
        week_id: {
          type: "string",
          description: "The week identifier to skip (e.g. '2024-W01')",
        },
      },
      required: ["week_id"],
    },
  },
  {
    name: "get_delivery_schedule",
    description:
      "View all upcoming deliveries including dates, selected meals, and delivery status.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "modify_delivery",
    description:
      "Change the delivery date for an upcoming week's box.",
    inputSchema: {
      type: "object",
      properties: {
        week_id: {
          type: "string",
          description: "The week identifier for the delivery to modify",
        },
        new_date: {
          type: "string",
          description: "New delivery date in YYYY-MM-DD format",
        },
      },
      required: ["week_id", "new_date"],
    },
  },
  {
    name: "get_preferences",
    description:
      "Get your current dietary preferences including vegetarian settings, allergens, cuisine types, and family-friendly options.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "update_preferences",
    description:
      "Update your dietary and cuisine preferences on HelloFresh, such as vegetarian mode, allergen avoidance, and preferred cuisines.",
    inputSchema: {
      type: "object",
      properties: {
        vegetarian: {
          type: "boolean",
          description: "Enable/disable vegetarian meal preference",
        },
        family_friendly: {
          type: "boolean",
          description: "Enable/disable family-friendly meals",
        },
        dietary_preferences: {
          type: "array",
          items: { type: "string" },
          description: "List of dietary preferences to set",
        },
        allergens: {
          type: "array",
          items: { type: "string" },
          description: "List of allergens to avoid",
        },
        cuisine_preferences: {
          type: "array",
          items: { type: "string" },
          description: "Preferred cuisine types",
        },
      },
    },
  },
  {
    name: "get_subscription",
    description:
      "View your current HelloFresh subscription plan details including meals per week, servings, price, and next delivery.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "modify_subscription",
    description:
      "Change your HelloFresh subscription plan size (meals per week or servings per meal) or delivery frequency.",
    inputSchema: {
      type: "object",
      properties: {
        meals_per_week: {
          type: "integer",
          description: "Number of meals per week (2-5)",
          minimum: 2,
          maximum: 5,
        },
        servings_per_meal: {
          type: "integer",
          description: "Number of servings per meal (2-4)",
          minimum: 2,
          maximum: 4,
        },
        frequency: {
          type: "string",
          enum: ["weekly", "biweekly"],
          description: "Delivery frequency",
        },
      },
    },
  },
  {
    name: "get_past_orders",
    description:
      "View your HelloFresh order history including delivery dates, meals received, and order status.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          description: "Maximum number of past orders to retrieve (default: 10, max: 50)",
          default: 10,
          minimum: 1,
          maximum: 50,
        },
      },
    },
  },
  {
    name: "rate_recipe",
    description:
      "Rate a HelloFresh recipe you've cooked on a scale of 1-5 stars, optionally including a written review.",
    inputSchema: {
      type: "object",
      properties: {
        recipe_id: {
          type: "string",
          description: "The recipe ID to rate",
        },
        rating: {
          type: "integer",
          description: "Rating from 1 (poor) to 5 (excellent)",
          minimum: 1,
          maximum: 5,
        },
        comment: {
          type: "string",
          description: "Optional written review/comment (max 500 chars)",
          maxLength: 500,
        },
      },
      required: ["recipe_id", "rating"],
    },
  },
];

// ─── Server Setup ─────────────────────────────────────────────────────────────

export class HelloFreshMCPServer {
  readonly server: Server;
  private readonly hellofresh: HelloFreshBrowser;
  private readonly allowInteractiveLogin: boolean;

  constructor(
    hellofresh: HelloFreshBrowser = new HelloFreshBrowser(),
    options: HelloFreshMCPServerOptions = {}
  ) {
    this.server = new Server(
      { name: "@striderlabs/mcp-hellofresh", version: "1.0.0" },
      { capabilities: { tools: {} } }
    );
    this.hellofresh = hellofresh;
    this.allowInteractiveLogin = options.allowInteractiveLogin ?? true;
    this.setupHandlers();
  }

  private async ensureInitialized(): Promise<void> {
    await this.hellofresh.ensureReady(readOptionalPasswordCredentials());
  }

  private setupHandlers(): void {
    this.server.setRequestHandler("tools/list", async () => ({
      tools: TOOLS,
    }));

    this.server.setRequestHandler("tools/call", async (request) => {
      const { name, arguments: args } = request.params;

      try {
        if (!AUTH_TOOL_NAMES.has(name)) {
          await this.ensureInitialized();
        }
        return await this.handleTool(name, args ?? {});
      } catch (error) {
        return formatAuthToolError(error);
      }
    });
  }

  private async notifyLoginWindow(): Promise<void> {
    if (!this.server.getClientCapabilities()?.elicitation) {
      return;
    }
    try {
      await this.server.elicitInput({
        mode: "form",
        message: LOGIN_WINDOW_MESSAGE,
        requestedSchema: {
          type: "object",
          properties: {},
        },
      });
    } catch {
      // Client declined, timed out, or does not implement forms — login still proceeds.
    }
  }

  private async handleTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<{ content: Array<{ type: "text"; text: string }> }> {
    const text = (data: unknown): { content: Array<{ type: "text"; text: string }> } => ({
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    });

    switch (name) {
      case "auth_status": {
        const status = await this.hellofresh.getAuthStatus();
        return text(status);
      }

      case "login": {
        assertInteractiveLoginAllowed({
          httpMode: !this.allowInteractiveLogin,
          hasInjectedHeadedLauncher: false,
        });
        void this.notifyLoginWindow();
        const result = await this.hellofresh.interactiveLogin();
        return text({
          ok: true,
          message:
            "HelloFresh session saved. Complete Google SSO is done; cookie values are not returned.",
          session_path: result.path,
          saved_at: result.savedAt,
        });
      }

      case "logout": {
        await this.hellofresh.logout();
        return text({
          ok: true,
          message: "HelloFresh session deleted and browser closed.",
        });
      }

      case "get_menu": {
        const params = GetMenuSchema.parse(args);
        const menu = await this.hellofresh.getMenu(params.week_offset);
        return text({
          week_offset: params.week_offset,
          recipe_count: menu.length,
          recipes: menu,
        });
      }

      case "get_recipe_details": {
        const params = GetRecipeDetailsSchema.parse(args);
        const details = await this.hellofresh.getRecipeDetails(params.recipe_id);
        return text(details);
      }

      case "select_meals": {
        const params = SelectMealsSchema.parse(args);
        const result = await this.hellofresh.selectMeals(
          params.week_id,
          params.meals.map((m) => ({ recipeId: m.recipe_id, servings: m.servings }))
        );
        return text(result);
      }

      case "skip_week": {
        const params = SkipWeekSchema.parse(args);
        const result = await this.hellofresh.skipWeek(params.week_id);
        return text(result);
      }

      case "get_delivery_schedule": {
        const schedule = await this.hellofresh.getDeliverySchedule();
        return text({
          delivery_count: schedule.length,
          deliveries: schedule,
        });
      }

      case "modify_delivery": {
        const params = ModifyDeliverySchema.parse(args);
        const result = await this.hellofresh.modifyDelivery(
          params.week_id,
          params.new_date
        );
        return text(result);
      }

      case "get_preferences": {
        const preferences = await this.hellofresh.getPreferences();
        return text(preferences);
      }

      case "update_preferences": {
        const params = UpdatePreferencesSchema.parse(args);
        const result = await this.hellofresh.updatePreferences({
          vegetarian: params.vegetarian,
          familyFriendly: params.family_friendly,
          dietaryPreferences: params.dietary_preferences,
          allergens: params.allergens,
          cuisinePreferences: params.cuisine_preferences,
        });
        return text(result);
      }

      case "get_subscription": {
        const subscription = await this.hellofresh.getSubscription();
        return text(subscription);
      }

      case "modify_subscription": {
        const params = ModifySubscriptionSchema.parse(args);
        const result = await this.hellofresh.modifySubscription({
          mealsPerWeek: params.meals_per_week,
          servingsPerMeal: params.servings_per_meal,
          frequency: params.frequency,
        });
        return text(result);
      }

      case "get_past_orders": {
        const params = GetPastOrdersSchema.parse(args);
        const orders = await this.hellofresh.getPastOrders(params.limit);
        return text({
          order_count: orders.length,
          orders,
        });
      }

      case "rate_recipe": {
        const params = RateRecipeSchema.parse(args);
        const result = await this.hellofresh.rateRecipe(
          params.recipe_id,
          params.rating,
          params.comment
        );
        return text(result);
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  async runStdio(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("HelloFresh MCP server running on stdio");

    const shutdown = async () => {
      await this.hellofresh.close();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  }
}
