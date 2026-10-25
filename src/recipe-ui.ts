import { createUIResource, type UIResource } from "@mcp-ui/server";

export const MENU_UI_URI = "ui://hellofresh/menu";
export const RECIPE_UI_URI = "ui://hellofresh/recipe";

const APP_SCRIPT =
  "https://unpkg.com/@modelcontextprotocol/ext-apps@1.7.5/dist/src/app-with-deps.js";
const IMAGE_ORIGIN = "https://img.hellofresh.com";
const APP_ORIGIN = "https://unpkg.com";

export interface RecipeUiDocument {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
  text: string;
  _meta?: Record<string, unknown>;
}

const DOCUMENTS: RecipeUiDocument[] = [
  documentFor({
    uri: MENU_UI_URI,
    name: "HelloFresh menu",
    description: "Recipe cards for one HelloFresh menu week.",
    appName: "HelloFresh menu",
    height: "640",
    mode: "menu",
  }),
  documentFor({
    uri: RECIPE_UI_URI,
    name: "HelloFresh recipe",
    description: "One HelloFresh recipe card, with ingredients and steps.",
    appName: "HelloFresh recipe",
    height: "840",
    mode: "recipe",
  }),
];

export function listRecipeUiResources(): Array<Omit<RecipeUiDocument, "text">> {
  return DOCUMENTS.map(({ text: _text, ...listed }) => listed);
}

export function readRecipeUiResource(uri: string): RecipeUiDocument | undefined {
  return DOCUMENTS.find((document) => document.uri === uri);
}

function documentFor(options: {
  uri: typeof MENU_UI_URI | typeof RECIPE_UI_URI;
  name: string;
  description: string;
  appName: string;
  height: string;
  mode: "menu" | "recipe";
}): RecipeUiDocument {
  const built = createUIResource({
    uri: options.uri,
    content: { type: "rawHtml", htmlString: page(options.appName, options.mode) },
    encoding: "text",
    uiMetadata: {
      "preferred-frame-size": ["720", options.height],
    },
    metadata: {
      ui: {
        csp: { resourceDomains: [IMAGE_ORIGIN, APP_ORIGIN] },
        prefersBorder: true,
      },
    },
  });
  const resource = textResource(built);
  return {
    uri: resource.uri,
    name: options.name,
    description: options.description,
    mimeType: resource.mimeType,
    text: resource.text,
    ...(resource._meta ? { _meta: resource._meta } : {}),
  };
}

function textResource(built: UIResource): {
  uri: string;
  mimeType: string;
  text: string;
  _meta?: Record<string, unknown>;
} {
  const resource = built.resource;
  if (!("text" in resource) || typeof resource.text !== "string") {
    throw new Error("Recipe card UI must be HTML text.");
  }
  return resource;
}

function page(appName: string, mode: "menu" | "recipe"): string {
  const render = mode === "menu" ? "renderMenu(data);" : "renderRecipe(data);";
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="color-scheme" content="light dark">
<title>${appName}</title>
<style>
  body { margin: 0; padding: 12px; font: 14px/1.4 system-ui, sans-serif; color: CanvasText; background: transparent; }
  .week { margin: 0 0 12px; font-weight: 650; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
  .card { border: 1px solid color-mix(in srgb, CanvasText 18%, transparent); border-radius: 12px; overflow: hidden; background: Canvas; }
  .card img { display: block; width: 100%; aspect-ratio: 4 / 3; object-fit: cover; background: color-mix(in srgb, CanvasText 8%, Canvas); }
  .body { display: grid; gap: 6px; padding: 10px 12px 12px; }
  .name { margin: 0; font-size: 16px; }
  .desc, .allergens { margin: 0; }
  .desc, .allergens { color: color-mix(in srgb, CanvasText 78%, Canvas); }
  .badges, .meta { display: flex; flex-wrap: wrap; gap: 6px; }
  .badges span, .meta span { font-size: 12px; padding: 2px 8px; border-radius: 999px; background: color-mix(in srgb, CanvasText 8%, Canvas); }
  .allergens, .section h3 { font-size: 12px; }
  .section { margin-top: 8px; }
  .section h3 { margin: 0 0 4px; }
  ol, ul { margin: 0; padding-left: 18px; }
  .single { max-width: 640px; }
</style>
</head>
<body>
<div id="root">Chargement…</div>
<script type="module">
import { App } from ${JSON.stringify(APP_SCRIPT)};
const CDN = ${JSON.stringify(`${IMAGE_ORIGIN}/`)};
const root = document.getElementById("root");

function text(el, value) {
  el.textContent = value == null ? "" : String(value);
}

function cdnSrc(url) {
  return typeof url === "string" && url.startsWith(CDN) ? url : "";
}

function allergenLine(recipe) {
  if (!recipe) return "";
  const parts = [];
  if (Array.isArray(recipe.allergens) && recipe.allergens.length) parts.push(recipe.allergens.join(", "));
  if (Array.isArray(recipe.allergenTraces) && recipe.allergenTraces.length) {
    parts.push("Traces : " + recipe.allergenTraces.join(", "));
  }
  return parts.join(" · ");
}

function listSection(title, items, ordered) {
  const section = document.createElement("section");
  section.className = "section";
  const heading = document.createElement("h3");
  text(heading, title);
  section.append(heading);
  const list = document.createElement(ordered ? "ol" : "ul");
  const values = Array.isArray(items) ? items : [];
  if (values.length === 0) {
    const item = document.createElement("li");
    text(item, "—");
    list.append(item);
  } else {
    for (const value of values) {
      const item = document.createElement("li");
      text(item, value);
      list.append(item);
    }
  }
  section.append(list);
  return section;
}

function fillCard(recipe, withDetails) {
  const card = document.createElement("article");
  card.className = "card";
  const src = cdnSrc(recipe && recipe.imageUrl);
  if (src) {
    const img = document.createElement("img");
    img.alt = "";
    img.src = src;
    card.append(img);
  }
  const body = document.createElement("div");
  body.className = "body";
  const name = document.createElement("h2");
  name.className = "name";
  text(name, recipe && recipe.name);
  body.append(name);
  if (recipe && recipe.description) {
    const desc = document.createElement("p");
    desc.className = "desc";
    text(desc, recipe.description);
    body.append(desc);
  }
  const badges = document.createElement("div");
  badges.className = "badges";
  const labels = [];
  if (recipe && recipe.label) labels.push(recipe.label);
  if (recipe && Array.isArray(recipe.tags)) labels.push.apply(labels, recipe.tags);
  for (const label of labels) {
    const badge = document.createElement("span");
    text(badge, label);
    badges.append(badge);
  }
  if (badges.childNodes.length) body.append(badges);
  const meta = document.createElement("div");
  meta.className = "meta";
  if (recipe && typeof recipe.prepTime === "number") {
    const item = document.createElement("span");
    text(item, recipe.prepTime + " min");
    meta.append(item);
  }
  if (recipe && typeof recipe.calories === "number") {
    const item = document.createElement("span");
    text(item, recipe.calories + " kcal");
    meta.append(item);
  }
  if (meta.childNodes.length) body.append(meta);
  const allergens = allergenLine(recipe);
  if (allergens) {
    const line = document.createElement("p");
    line.className = "allergens";
    text(line, allergens);
    body.append(line);
  }
  if (withDetails) {
    body.append(listSection("Ingrédients", recipe && recipe.ingredients, false));
    body.append(listSection("Étapes", recipe && recipe.steps, true));
  }
  card.append(body);
  return card;
}

function renderMenu(data) {
  root.replaceChildren();
  const week = data && typeof data.week_id === "string" ? data.week_id : "";
  if (week) {
    const heading = document.createElement("p");
    heading.className = "week";
    text(heading, week);
    root.append(heading);
  }
  const recipes = data && Array.isArray(data.recipes) ? data.recipes : [];
  if (recipes.length === 0) {
    const empty = document.createElement("p");
    text(empty, "Aucune recette.");
    root.append(empty);
    return;
  }
  const grid = document.createElement("div");
  grid.className = "grid";
  for (const recipe of recipes) grid.append(fillCard(recipe, false));
  root.append(grid);
}

function renderRecipe(data) {
  root.replaceChildren();
  const card = fillCard(data && typeof data === "object" ? data : {}, true);
  card.classList.add("single");
  root.append(card);
}

const app = new App({ name: ${JSON.stringify(appName)}, version: "1.0.0" });
app.ontoolresult = (result) => {
  const data = result && result.structuredContent && typeof result.structuredContent === "object"
    ? result.structuredContent
    : {};
  ${render}
};
await app.connect();
</script>
</body>
</html>`;
}
