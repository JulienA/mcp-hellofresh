"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HelloFreshMCPServer = void 0;
const server_1 = require("@modelcontextprotocol/server");
const stdio_1 = require("@modelcontextprotocol/server/stdio");
const zod_1 = require("zod");
const auth_js_1 = require("./auth.js");
const hellofresh_api_js_1 = require("./hellofresh-api.js");
const log_js_1 = require("./log.js");
const login_mode_js_1 = require("./login-mode.js");
const request_context_js_1 = require("./request-context.js");
// ─── Schemas ──────────────────────────────────────────────────────────────────
const GetMenuSchema = zod_1.z.object({
    week_offset: zod_1.z
        .int()
        .min(0)
        .max(4)
        .optional()
        .default(0)
        .describe("Week offset from current week (0 = current, 1 = next week, etc.)"),
});
const GetRecipeDetailsSchema = zod_1.z.object({
    recipe_id: zod_1.z.string().describe("The unique recipe identifier"),
});
const SelectMealsSchema = zod_1.z.object({
    week_id: zod_1.z
        .string()
        .describe("The week identifier (e.g. '2024-W01') for the delivery"),
    meals: zod_1.z
        .array(zod_1.z.object({
        recipe_id: zod_1.z.string().describe("Recipe ID to select"),
        servings: zod_1.z
            .int()
            .min(1)
            .max(6)
            .optional()
            .describe("Number of servings (defaults to subscription default)"),
    }))
        .min(1)
        .describe("List of meals to select"),
});
const SkipWeekSchema = zod_1.z.object({
    week_id: zod_1.z.string().describe("The week identifier to skip (e.g. '2024-W01')"),
});
const ModifyDeliverySchema = zod_1.z.object({
    week_id: zod_1.z.string().describe("The week identifier for the delivery to modify"),
    new_date: zod_1.z
        .string()
        .describe("New delivery date in YYYY-MM-DD format"),
});
const UpdatePreferencesSchema = zod_1.z.object({
    vegetarian: zod_1.z
        .boolean()
        .optional()
        .describe("Enable/disable vegetarian meal preference"),
    family_friendly: zod_1.z
        .boolean()
        .optional()
        .describe("Enable/disable family-friendly meals"),
    dietary_preferences: zod_1.z
        .array(zod_1.z.string())
        .optional()
        .describe("List of dietary preferences to set"),
    allergens: zod_1.z
        .array(zod_1.z.string())
        .optional()
        .describe("List of allergens to avoid"),
    cuisine_preferences: zod_1.z
        .array(zod_1.z.string())
        .optional()
        .describe("Preferred cuisine types"),
});
const ModifySubscriptionSchema = zod_1.z.object({
    meals_per_week: zod_1.z
        .int()
        .min(2)
        .max(5)
        .optional()
        .describe("Number of meals per week (2-5)"),
    servings_per_meal: zod_1.z
        .int()
        .min(2)
        .max(4)
        .optional()
        .describe("Number of servings per meal (2-4)"),
    frequency: zod_1.z
        .enum(["weekly", "biweekly"])
        .optional()
        .describe("Delivery frequency"),
});
const GetPastOrdersSchema = zod_1.z.object({
    limit: zod_1.z
        .int()
        .min(1)
        .max(50)
        .optional()
        .default(10)
        .describe("Maximum number of past orders to retrieve"),
});
const RateRecipeSchema = zod_1.z.object({
    recipe_id: zod_1.z.string().describe("The recipe ID to rate"),
    rating: zod_1.z
        .int()
        .min(1)
        .max(5)
        .describe("Rating from 1 (poor) to 5 (excellent)"),
    comment: zod_1.z
        .string()
        .max(500)
        .optional()
        .describe("Optional written review/comment"),
});
// ─── Tool Definitions ─────────────────────────────────────────────────────────
const TOOLS = [
    {
        name: "auth_status",
        description: "Show the linked HelloFresh email and country, whether the access token is still valid, and when it was saved. Never returns tokens.",
        inputSchema: {
            type: "object",
            properties: {},
        },
    },
    {
        name: "login",
        description: "On a local stdio server, open a headed window so you can finish Continue with Google yourself; only apiV2Auth is saved. On the HTTP connector this does not sign you in: disconnect and reconnect, then use the authorize page. Never send a password to this tool.",
        inputSchema: {
            type: "object",
            properties: {},
        },
    },
    {
        name: "logout",
        description: "Delete the saved HelloFresh tokens for this account only. Does not sign you out of Google.",
        inputSchema: {
            type: "object",
            properties: {},
        },
    },
    {
        name: "get_menu",
        description: "Get the current week's available recipes/meals from HelloFresh. Optionally specify a week offset to see future menus.",
        inputSchema: {
            type: "object",
            properties: {
                week_offset: {
                    type: "integer",
                    description: "Week offset from current week (0 = current, 1 = next week, etc.)",
                    default: 0,
                    minimum: 0,
                    maximum: 4,
                },
            },
        },
    },
    {
        name: "get_recipe_details",
        description: "Get full recipe information including ingredients, step-by-step instructions, nutrition facts, prep time, and allergen information.",
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
        description: "Choose specific meals for an upcoming delivery week. You can select multiple recipes by their IDs.",
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
        description: "Skip a delivery week so you won't receive or be charged for that week's box.",
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
        description: "View all upcoming deliveries including dates, selected meals, and delivery status.",
        inputSchema: {
            type: "object",
            properties: {},
        },
    },
    {
        name: "modify_delivery",
        description: "Change the delivery date for an upcoming week's box.",
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
        description: "Get your current dietary preferences including vegetarian settings, allergens, cuisine types, and family-friendly options.",
        inputSchema: {
            type: "object",
            properties: {},
        },
    },
    {
        name: "update_preferences",
        description: "Update your dietary and cuisine preferences on HelloFresh, such as vegetarian mode, allergen avoidance, and preferred cuisines.",
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
        description: "View your current HelloFresh subscription plan details including meals per week, servings, price, and next delivery.",
        inputSchema: {
            type: "object",
            properties: {},
        },
    },
    {
        name: "modify_subscription",
        description: "Change your HelloFresh subscription plan size (meals per week or servings per meal) or delivery frequency.",
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
        description: "View your HelloFresh order history including delivery dates, meals received, and order status.",
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
        description: "Rate a HelloFresh recipe. The HelloFresh API this connector uses has no rating endpoint, so the tool returns that limitation.",
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
class HelloFreshMCPServer {
    server;
    session;
    allowInteractiveLogin;
    constructor(session, options = {}) {
        this.server = new server_1.Server({ name: "@striderlabs/mcp-hellofresh", version: "1.0.0" }, { capabilities: { tools: {} } });
        this.session = session;
        this.allowInteractiveLogin = options.allowInteractiveLogin ?? true;
        this.setupHandlers();
    }
    setupHandlers() {
        this.server.setRequestHandler("tools/list", async () => ({
            tools: TOOLS,
        }));
        this.server.setRequestHandler("tools/call", async (request) => {
            const { name, arguments: args } = request.params;
            const started = Date.now();
            const userId = (0, request_context_js_1.currentHelloFreshUserId)();
            try {
                const result = await this.handleTool(name, args ?? {});
                log_js_1.log.info("mcp.tool", {
                    name,
                    userId,
                    durationMs: Date.now() - started,
                    ok: true,
                });
                return result;
            }
            catch (error) {
                log_js_1.log.warn("mcp.tool", {
                    name,
                    userId,
                    durationMs: Date.now() - started,
                    ok: false,
                    code: (0, log_js_1.errorCode)(error),
                });
                return (0, auth_js_1.formatAuthToolError)(error);
            }
        });
    }
    async notifyLoginWindow() {
        if (!this.server.getClientCapabilities()?.elicitation) {
            return;
        }
        try {
            await this.server.elicitInput({
                mode: "form",
                message: auth_js_1.LOGIN_WINDOW_MESSAGE,
                requestedSchema: {
                    type: "object",
                    properties: {},
                },
            });
        }
        catch {
            // Client declined, timed out, or does not implement forms — login still proceeds.
        }
    }
    async handleTool(name, args) {
        const text = (data) => ({
            content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        });
        switch (name) {
            case "auth_status": {
                const status = await this.session.status();
                return text(status);
            }
            case "login": {
                if (!this.allowInteractiveLogin || !this.session.login) {
                    throw auth_js_1.AuthError.loginFailed(login_mode_js_1.HTTP_LOGIN_MESSAGE);
                }
                (0, login_mode_js_1.assertInteractiveLoginAllowed)({
                    httpMode: false,
                    hasInjectedHeadedLauncher: false,
                });
                void this.notifyLoginWindow();
                const result = await this.session.login();
                return text({
                    ok: true,
                    message: "HelloFresh account saved. Token values are not returned.",
                    email: result.email,
                    country: result.country,
                    saved_at: result.savedAt,
                });
            }
            case "logout": {
                await this.session.logout();
                return text({
                    ok: true,
                    message: "HelloFresh tokens for this account were deleted.",
                });
            }
            case "get_menu": {
                const params = GetMenuSchema.parse(args);
                const menu = await (await this.session.api()).getMenu(params.week_offset);
                return text({
                    week_offset: params.week_offset,
                    week_id: menu.weekId,
                    recipe_count: menu.recipes.length,
                    recipes: menu.recipes,
                });
            }
            case "get_recipe_details": {
                const params = GetRecipeDetailsSchema.parse(args);
                const details = await (await this.session.api()).getRecipe(params.recipe_id);
                return text(details);
            }
            case "select_meals": {
                const params = SelectMealsSchema.parse(args);
                const result = await (await this.session.api()).selectMeals(params.week_id, params.meals.map((m) => ({ recipeId: m.recipe_id, servings: m.servings })));
                return text(result);
            }
            case "skip_week": {
                const params = SkipWeekSchema.parse(args);
                const result = await (await this.session.api()).skipWeek(params.week_id);
                return text(result);
            }
            case "get_delivery_schedule": {
                const schedule = await (await this.session.api()).getDeliveries();
                return text({
                    delivery_count: schedule.length,
                    deliveries: schedule.map((week) => ({
                        weekId: week.weekId,
                        deliveryDate: week.deliveryDate ?? "",
                        status: week.status ?? "",
                        meals: week.meals,
                        canModify: (week.status ?? "").toUpperCase() !== "PAUSED",
                    })),
                });
            }
            case "modify_delivery": {
                const params = ModifyDeliverySchema.parse(args);
                const result = await (await this.session.api()).modifyDelivery(params.week_id, params.new_date);
                return text(result);
            }
            case "get_preferences": {
                const preferences = await (await this.session.api()).getPreferences();
                return text(preferences);
            }
            case "update_preferences": {
                const params = UpdatePreferencesSchema.parse(args);
                const result = await (await this.session.api()).updatePreferences({
                    vegetarian: params.vegetarian,
                    familyFriendly: params.family_friendly,
                    dietaryPreferences: params.dietary_preferences,
                    allergens: params.allergens,
                    cuisinePreferences: params.cuisine_preferences,
                });
                return text(result);
            }
            case "get_subscription": {
                const subscription = await (await this.session.api()).getSubscription();
                return text(subscription);
            }
            case "modify_subscription": {
                const params = ModifySubscriptionSchema.parse(args);
                const result = await (await this.session.api()).modifySubscription({
                    mealsPerWeek: params.meals_per_week,
                    servingsPerMeal: params.servings_per_meal,
                    frequency: params.frequency,
                });
                return text(result);
            }
            case "get_past_orders": {
                const params = GetPastOrdersSchema.parse(args);
                const orders = await (await this.session.api()).getPastOrders(params.limit);
                return text({
                    order_count: orders.length,
                    orders,
                });
            }
            case "rate_recipe": {
                RateRecipeSchema.parse(args);
                throw new hellofresh_api_js_1.HelloFreshApiError("unsupported", hellofresh_api_js_1.RATE_RECIPE_UNSUPPORTED);
            }
            default:
                throw new Error(`Unknown tool: ${name}`);
        }
    }
    async runStdio() {
        const transport = new stdio_1.StdioServerTransport();
        await this.server.connect(transport);
        log_js_1.log.info("stdio.listen");
        const shutdown = () => {
            process.exit(0);
        };
        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
    }
}
exports.HelloFreshMCPServer = HelloFreshMCPServer;
//# sourceMappingURL=mcp-server.js.map