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
//# sourceMappingURL=recipe-ui.d.ts.map