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
    height: "720",
    mode: "menu",
  }),
  documentFor({
    uri: RECIPE_UI_URI,
    name: "HelloFresh recipe",
    description: "One HelloFresh recipe card, with photo, tags, and prep time.",
    appName: "HelloFresh recipe",
    height: "480",
    mode: "recipe",
  }),
];

export function listRecipeUiResources(): Array<Omit<RecipeUiDocument, "text">> {
  return DOCUMENTS.map(({ text: _text, ...listed }) => listed);
}

export function readRecipeUiResource(uri: string): RecipeUiDocument | undefined {
  return DOCUMENTS.find((document) => document.uri === uri);
}

/** ISO week `YYYY-Www` as a French Monday–Sunday range, e.g. "9 – 15 novembre 2026". */
export function menuWeekLabel(weekId: string): string {
  const match = /^(\d{4})-W(\d{2})$/.exec(weekId);
  if (!match) {
    return weekId;
  }
  const year = Number(match[1]);
  const week = Number(match[2]);
  if (week < 1 || week > 53) {
    return weekId;
  }
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7) + (week - 1) * 7);
  const thursday = new Date(monday);
  thursday.setUTCDate(monday.getUTCDate() + 3);
  if (thursday.getUTCFullYear() !== year) {
    return weekId;
  }
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  const sameYear = monday.getUTCFullYear() === sunday.getUTCFullYear();
  const sameMonth = sameYear && monday.getUTCMonth() === sunday.getUTCMonth();
  const start = new Intl.DateTimeFormat("fr-FR", {
    day: "numeric",
    ...(sameMonth ? {} : { month: "long" as const }),
    ...(sameYear ? {} : { year: "numeric" as const }),
    timeZone: "UTC",
  }).format(monday);
  const end = new Intl.DateTimeFormat("fr-FR", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(sunday);
  return `${start} – ${end}`;
}

/** Calendar date from a HelloFresh timestamp, e.g. "31 octobre 2026". */
export function deliveryDateLabel(deliveryDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(deliveryDate);
  if (!match) {
    return "";
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return "";
  }
  return new Intl.DateTimeFormat("fr-FR", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
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
  .week:has(+ .delivery) { margin-bottom: 2px; }
  .delivery { margin: 0 0 12px; color: color-mix(in srgb, CanvasText 78%, Canvas); }
  .toolbar { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 12px; }
  .toolbar input, .toolbar select, .pager button, .validate {
    font: inherit; color: CanvasText; background: Canvas;
    border: 1px solid color-mix(in srgb, CanvasText 18%, transparent); border-radius: 8px;
  }
  .toolbar input, .toolbar select { padding: 6px 8px; }
  .toolbar input { min-width: 140px; flex: 1; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
  .card { border: 1px solid color-mix(in srgb, CanvasText 18%, transparent); border-radius: 12px; overflow: hidden; background: Canvas; }
  .card img { display: block; width: 100%; aspect-ratio: 4 / 3; object-fit: cover; background: color-mix(in srgb, CanvasText 8%, Canvas); }
  .body { display: grid; gap: 6px; padding: 10px 12px 12px; }
  .name { margin: 0; font-size: 16px; }
  .desc, .allergens { margin: 0; color: color-mix(in srgb, CanvasText 78%, Canvas); }
  .badges, .meta { display: flex; flex-wrap: wrap; gap: 6px; }
  .badges span, .meta span { font-size: 12px; padding: 2px 8px; border-radius: 999px; background: color-mix(in srgb, CanvasText 8%, Canvas); }
  .allergens { font-size: 12px; }
  .validate { justify-self: start; padding: 6px 10px; cursor: pointer; background: color-mix(in srgb, CanvasText 8%, Canvas); }
  .pager { display: flex; align-items: center; gap: 8px; margin: 12px 0 0; }
  .pager button { padding: 6px 10px; cursor: pointer; background: color-mix(in srgb, CanvasText 8%, Canvas); }
  .pager button:disabled, .validate:disabled { opacity: 0.5; cursor: default; }
  .single { max-width: 640px; }
</style>
</head>
<body>
<div id="root">Chargement…</div>
<script type="module">
import { App } from ${JSON.stringify(APP_SCRIPT)};
const CDN = ${JSON.stringify(`${IMAGE_ORIGIN}/`)};
const PAGE_SIZE = 6;
const root = document.getElementById("root");
const app = new App({ name: ${JSON.stringify(appName)}, version: "1.0.0" });
let menuWeek = "";
let menuRecipes = [];
let menuQuery = "";
let menuTag = "";
let menuMaxTime = 0;
let menuPage = 1;
let resultsEl = null;
let pagerEl = null;

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

function uniqueTags(recipes) {
  const seen = [];
  for (const recipe of recipes) {
    const tags = recipe && Array.isArray(recipe.tags) ? recipe.tags : [];
    for (const tag of tags) {
      if (typeof tag !== "string" || !tag) continue;
      if (seen.some((item) => item.toLocaleLowerCase() === tag.toLocaleLowerCase())) continue;
      seen.push(tag);
    }
  }
  seen.sort((a, b) => a.localeCompare(b, "fr"));
  return seen;
}

function filteredRecipes(recipes, query, tag, maxTime) {
  const q = query.trim().toLocaleLowerCase();
  return recipes.filter((recipe) => {
    const name = String(recipe && recipe.name || "").toLocaleLowerCase();
    if (q && name.indexOf(q) < 0) return false;
    if (tag) {
      const tags = recipe && Array.isArray(recipe.tags) ? recipe.tags : [];
      const key = tag.toLocaleLowerCase();
      if (!tags.some((item) => String(item).toLocaleLowerCase() === key)) return false;
    }
    if (maxTime && !(recipe && typeof recipe.prepTime === "number" && recipe.prepTime <= maxTime)) {
      return false;
    }
    return true;
  });
}

function validateButton(recipe) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "validate";
  text(button, "Valider");
  button.addEventListener("click", async () => {
    const name = recipe && recipe.name ? String(recipe.name) : "";
    const id = recipe && recipe.id ? String(recipe.id) : "";
    button.disabled = true;
    try {
      const result = await app.sendMessage({
        role: "user",
        content: [{
          type: "text",
          text: "Valide la recette « " + name + " » (id: " + id + ") pour la semaine " + menuWeek + ".",
        }],
      });
      if (result && result.isError) {
        button.disabled = false;
        text(button, "Erreur");
        return;
      }
      text(button, "Envoyé");
    } catch {
      button.disabled = false;
      text(button, "Erreur");
    }
  });
  return button;
}

function fillCard(recipe, forMenu) {
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
  if (forMenu && recipe && recipe.description) {
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
  if (forMenu && recipe && typeof recipe.calories === "number") {
    const item = document.createElement("span");
    text(item, recipe.calories + " kcal");
    meta.append(item);
  }
  if (meta.childNodes.length) body.append(meta);
  if (forMenu) {
    const allergens = allergenLine(recipe);
    if (allergens) {
      const line = document.createElement("p");
      line.className = "allergens";
      text(line, allergens);
      body.append(line);
    }
    body.append(validateButton(recipe));
  }
  card.append(body);
  return card;
}

function option(select, value, label) {
  const item = document.createElement("option");
  item.value = value;
  text(item, label);
  select.append(item);
}

function toolbar() {
  const bar = document.createElement("div");
  bar.className = "toolbar";
  const search = document.createElement("input");
  search.type = "search";
  search.placeholder = "Rechercher";
  search.addEventListener("input", () => {
    menuQuery = search.value;
    menuPage = 1;
    drawResults();
  });
  const tagSelect = document.createElement("select");
  option(tagSelect, "", "Tous");
  for (const tag of uniqueTags(menuRecipes)) option(tagSelect, tag, tag);
  tagSelect.addEventListener("change", () => {
    menuTag = tagSelect.value;
    menuPage = 1;
    drawResults();
  });
  const timeSelect = document.createElement("select");
  option(timeSelect, "0", "Tous");
  option(timeSelect, "20", "≤ 20 min");
  option(timeSelect, "30", "≤ 30 min");
  option(timeSelect, "45", "≤ 45 min");
  timeSelect.addEventListener("change", () => {
    menuMaxTime = Number(timeSelect.value) || 0;
    menuPage = 1;
    drawResults();
  });
  bar.append(search, tagSelect, timeSelect);
  return bar;
}

function drawPager(pages) {
  pagerEl.replaceChildren();
  const prev = document.createElement("button");
  prev.type = "button";
  text(prev, "Précédent");
  prev.disabled = menuPage <= 1;
  prev.addEventListener("click", () => {
    menuPage -= 1;
    drawResults();
  });
  const label = document.createElement("span");
  text(label, menuPage + " / " + pages);
  const next = document.createElement("button");
  next.type = "button";
  text(next, "Suivant");
  next.disabled = menuPage >= pages;
  next.addEventListener("click", () => {
    menuPage += 1;
    drawResults();
  });
  pagerEl.append(prev, label, next);
}

function drawResults() {
  const matched = filteredRecipes(menuRecipes, menuQuery, menuTag, menuMaxTime);
  const pages = Math.max(1, Math.ceil(matched.length / PAGE_SIZE));
  if (menuPage > pages) menuPage = pages;
  resultsEl.replaceChildren();
  if (matched.length === 0) {
    const empty = document.createElement("p");
    text(empty, "Aucune recette.");
    resultsEl.append(empty);
    pagerEl.replaceChildren();
    return;
  }
  const grid = document.createElement("div");
  grid.className = "grid";
  const start = (menuPage - 1) * PAGE_SIZE;
  for (const recipe of matched.slice(start, start + PAGE_SIZE)) {
    grid.append(fillCard(recipe, true));
  }
  resultsEl.append(grid);
  drawPager(pages);
}

function isoWeekLabel(weekId) {
  const match = /^(\\d{4})-W(\\d{2})$/.exec(String(weekId || ""));
  if (!match) return weekId || "";
  const year = Number(match[1]);
  const week = Number(match[2]);
  if (week < 1 || week > 53) return weekId;
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7) + (week - 1) * 7);
  const thursday = new Date(monday);
  thursday.setUTCDate(monday.getUTCDate() + 3);
  if (thursday.getUTCFullYear() !== year) return weekId;
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  const sameYear = monday.getUTCFullYear() === sunday.getUTCFullYear();
  const sameMonth = sameYear && monday.getUTCMonth() === sunday.getUTCMonth();
  const startOptions = { day: "numeric", timeZone: "UTC" };
  if (!sameMonth) startOptions.month = "long";
  if (!sameYear) startOptions.year = "numeric";
  const start = new Intl.DateTimeFormat("fr-FR", startOptions).format(monday);
  const end = new Intl.DateTimeFormat("fr-FR", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(sunday);
  return start + " – " + end;
}

function deliveryDateLabel(value) {
  const match = /^(\\d{4})-(\\d{2})-(\\d{2})/.exec(String(value || ""));
  if (!match) return "";
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return "";
  return new Intl.DateTimeFormat("fr-FR", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function weekHeading(data) {
  const weekId = data && typeof data.week_id === "string" ? data.week_id : "";
  const fromId = isoWeekLabel(weekId);
  if (fromId) return fromId;
  const labeled = data && typeof data.week_label === "string" ? data.week_label.trim() : "";
  return labeled || weekId;
}

function deliveryHeading(data) {
  const labeled = data && typeof data.delivery_label === "string" ? data.delivery_label.trim() : "";
  if (labeled) return labeled;
  return deliveryDateLabel(data && typeof data.delivery_date === "string" ? data.delivery_date : "");
}

function renderMenu(data) {
  menuWeek = data && typeof data.week_id === "string" ? data.week_id : "";
  menuRecipes = data && Array.isArray(data.recipes) ? data.recipes : [];
  menuQuery = "";
  menuTag = "";
  menuMaxTime = 0;
  menuPage = 1;
  root.replaceChildren();
  const headingText = weekHeading(data);
  if (headingText) {
    const heading = document.createElement("p");
    heading.className = "week";
    text(heading, headingText);
    root.append(heading);
  }
  const deliveryText = deliveryHeading(data);
  if (deliveryText) {
    const delivery = document.createElement("p");
    delivery.className = "delivery";
    text(delivery, "Livraison le " + deliveryText);
    root.append(delivery);
  }
  if (menuRecipes.length === 0) {
    const empty = document.createElement("p");
    text(empty, "Aucune recette.");
    root.append(empty);
    return;
  }
  resultsEl = document.createElement("div");
  pagerEl = document.createElement("div");
  pagerEl.className = "pager";
  root.append(toolbar(), resultsEl, pagerEl);
  drawResults();
}

function renderRecipe(data) {
  root.replaceChildren();
  const card = fillCard(data && typeof data === "object" ? data : {}, false);
  card.classList.add("single");
  root.append(card);
}

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
