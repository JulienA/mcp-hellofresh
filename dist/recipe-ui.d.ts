export declare const MENU_UI_URI = "ui://hellofresh/menu";
export declare const RECIPE_UI_URI = "ui://hellofresh/recipe";
export interface RecipeUiDocument {
    uri: string;
    name: string;
    description: string;
    mimeType: string;
    text: string;
    _meta?: Record<string, unknown>;
}
export declare function listRecipeUiResources(): Array<Omit<RecipeUiDocument, "text">>;
export declare function readRecipeUiResource(uri: string): RecipeUiDocument | undefined;
/** ISO week `YYYY-Www` as a French Monday–Sunday range, e.g. "9 – 15 novembre 2026". */
export declare function menuWeekLabel(weekId: string): string;
/** Calendar date from a HelloFresh timestamp, e.g. "31 octobre 2026". */
export declare function deliveryDateLabel(deliveryDate: string): string;
//# sourceMappingURL=recipe-ui.d.ts.map