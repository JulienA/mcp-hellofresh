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
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${appName}</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 12px;
    font: 14px/1.45 system-ui, sans-serif;
    color: CanvasText; background: transparent;
  }
  button, input, select { font: inherit; color: inherit; }
  button, input, select {
    border: 1px solid color-mix(in srgb, CanvasText 22%, transparent);
    border-radius: 8px; background: Canvas; padding: 8px 10px;
  }
  button { cursor: pointer; }
  button:focus-visible, input:focus-visible, select:focus-visible {
    outline: 2px solid Highlight; outline-offset: 2px;
  }
  .week { margin: 0 0 12px; font-weight: 700; font-size: 18px; }
  .toolbar { display: grid; gap: 10px; margin-bottom: 14px; }
  .filters {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(145px, 1fr));
    gap: 8px;
  }
  .field { display: grid; gap: 4px; min-width: 0; }
  .field label, .filter-title { font-size: 12px; font-weight: 650; }
  .field input, .field select { width: 100%; min-width: 0; }
  .filter-heading {
    display: flex; align-items: center; justify-content: space-between;
    gap: 8px; flex-wrap: wrap;
  }
  .filter-heading h2 { font-size: 14px; margin: 0; }
  .text-button {
    border: 0; padding: 4px 0; background: transparent;
    text-decoration: underline; font-size: 12px;
  }
  .tag-filters { display: flex; flex-wrap: wrap; gap: 6px; }
  .tag-option {
    display: inline-flex; align-items: center; gap: 5px;
    padding: 5px 9px; border-radius: 999px;
    border: 1px solid color-mix(in srgb, CanvasText 20%, transparent);
    cursor: pointer; font-size: 12px;
  }
  .tag-option input { margin: 0; accent-color: Highlight; }
  .toggle-row {
    display: flex; align-items: center; justify-content: space-between;
    gap: 10px; flex-wrap: wrap;
  }
  .check-label { display: inline-flex; align-items: center; gap: 7px; }
  .check-label input { accent-color: Highlight; }
  .summary { font-size: 12px; opacity: .8; }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 220px), 1fr));
    gap: 12px; align-items: start;
  }
  .card {
    min-width: 0;
    border: 1px solid color-mix(in srgb, CanvasText 18%, transparent);
    border-radius: 12px; overflow: hidden; background: Canvas;
  }
  .card img {
    display: block; width: 100%; aspect-ratio: 4 / 3;
    object-fit: cover; background: color-mix(in srgb, CanvasText 8%, Canvas);
  }
  .body { display: grid; gap: 8px; padding: 10px 12px 12px; }
  .name { margin: 0; font-size: 15px; line-height: 1.3; }
  .desc, .allergens { margin: 0; font-size: 12px; opacity: .8; }
  .badges, .meta { display: flex; flex-wrap: wrap; gap: 5px; }
  .badges span, .meta span {
    font-size: 11px; padding: 3px 7px; border-radius: 999px;
    background: color-mix(in srgb, CanvasText 8%, Canvas);
  }
  .selection-button { width: 100%; font-weight: 650; }
  .selection-button.selected {
    background: color-mix(in srgb, Highlight 14%, Canvas);
    border-color: Highlight;
  }
  .empty {
    padding: 24px 12px; text-align: center;
    border: 1px dashed color-mix(in srgb, CanvasText 25%, transparent);
    border-radius: 12px; opacity: .8;
  }
  .recipe-header { margin-bottom: 16px; }
  .recipe-header .name { font-size: 21px; }
  .recipe-layout { display: grid; gap: 16px; }
  .section {
    border: 1px solid color-mix(in srgb, CanvasText 18%, transparent);
    border-radius: 12px; padding: 14px;
  }
  .section h2 { margin: 0 0 12px; font-size: 17px; }
  .section ol, .section ul { margin: 0; padding-left: 22px; }
  .section li { padding-left: 4px; margin-bottom: 8px; }
  .section li:last-child { margin-bottom: 0; }
  .step-list li { padding-bottom: 8px; }
  .single { max-width: 760px; margin: 0 auto; }
  .ingredients-list { columns: 2; column-gap: 24px; }
  .ingredients-list li { break-inside: avoid; }
  @media (max-width: 420px) {
    body { padding: 8px; }
    .ingredients-list { columns: 1; }
    .filters { grid-template-columns: 1fr 1fr; }
    .filters .field:first-child { grid-column: 1 / -1; }
  }
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

function element(tag, className, value) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (value != null) text(el, value);
  return el;
}

function cdnSrc(url) {
  return typeof url === "string" && url.startsWith(CDN) ? url : "";
}

function allergenLine(recipe) {
  if (!recipe) return "";
  const parts = [];
  if (Array.isArray(recipe.allergens) && recipe.allergens.length)
    parts.push(recipe.allergens.join(", "));
  if (Array.isArray(recipe.allergenTraces) && recipe.allergenTraces.length)
    parts.push("Traces : " + recipe.allergenTraces.join(", "));
  return parts.join(" · ");
}

function recipeKey(recipe) {
  return String(recipe.id || recipe.slug || recipe.recipeId || recipe.name || "");
}

function recipeTags(recipe) {
  const tags = [];
  if (recipe && recipe.label) tags.push(recipe.label);
  if (recipe && Array.isArray(recipe.tags)) tags.push.apply(tags, recipe.tags);
  return Array.from(new Set(tags.filter(Boolean).map(String)));
}

function appendBadges(parent, labels) {
  if (!labels.length) return;
  const badges = element("div", "badges");
  labels.forEach(function(label) {
    badges.append(element("span", "", label));
  });
  parent.append(badges);
}

function appendMeta(parent, recipe) {
  const meta = element("div", "meta");
  if (typeof recipe.prepTime === "number")
    meta.append(element("span", "", recipe.prepTime + " min"));
  if (typeof recipe.calories === "number")
    meta.append(element("span", "", recipe.calories + " kcal"));
  if (meta.childNodes.length) parent.append(meta);
}

function fillCard(recipe, options) {
  options = options || {};
  const card = element("article", "card");
  const src = cdnSrc(recipe && recipe.imageUrl);

  if (src) {
    const img = element("img");
    img.src = src;
    img.alt = recipe.name ? "Photo de " + recipe.name : "Photo de recette";
    img.loading = "lazy";
    img.onerror = function() { img.remove(); };
    card.append(img);
  }

  const body = element("div", "body");
  body.append(element("h2", "name", recipe && recipe.name || "Recette sans nom"));

  if (recipe && recipe.description)
    body.append(element("p", "desc", recipe.description));

  appendBadges(body, recipeTags(recipe || {}));
  appendMeta(body, recipe || {});

  const allergens = allergenLine(recipe);
  if (allergens) body.append(element("p", "allergens", allergens));

  if (options.selection) {
    const key = recipeKey(recipe);
    const selected = selectedRecipes.has(key);
    const button = element(
      "button",
      "selection-button" + (selected ? " selected" : ""),
      selected ? "✓ Sélectionnée" : "+ Ajouter au menu"
    );
    button.type = "button";
    button.setAttribute("aria-pressed", String(selected));
    button.addEventListener("click", function() {
      if (selectedRecipes.has(key)) selectedRecipes.delete(key);
      else selectedRecipes.add(key);
      updateMenu();
    });
    body.append(button);
  }

  card.append(body);
  return card;
}

/* Menu : filtres et sélection restent au même endroit que les recettes. */
let menuData = {};
let selectedRecipes = new Set();
let searchQuery = "";
let maxPrep = "";
let maxCalories = "";
let selectedTags = new Set();
let excludedAllergens = "";
let selectedOnly = false;
let sortMode = "default";

function createField(labelText, control) {
  const wrapper = element("div", "field");
  const label = element("label", "", labelText);
  label.htmlFor = control.id;
  wrapper.append(label, control);
  return wrapper;
}

function createSelect(id, options) {
  const select = element("select");
  select.id = id;
  options.forEach(function(option) {
    const item = element("option", "", option.label);
    item.value = option.value;
    select.append(item);
  });
  return select;
}

function getFilteredRecipes() {
  const recipes = Array.isArray(menuData.recipes) ? menuData.recipes : [];
  const query = searchQuery.trim().toLocaleLowerCase();
  const allergenQuery = excludedAllergens.trim().toLocaleLowerCase();

  return recipes.filter(function(recipe) {
    const name = String(recipe.name || "").toLocaleLowerCase();
    const description = String(recipe.description || "").toLocaleLowerCase();
    const tags = recipeTags(recipe);
    const allergens = allergenLine(recipe).toLocaleLowerCase();

    if (query && !(name + " " + description + " " + tags.join(" "))
      .toLocaleLowerCase().includes(query)) return false;

    if (maxPrep !== "" &&
      (typeof recipe.prepTime !== "number" || recipe.prepTime > Number(maxPrep)))
      return false;

    if (maxCalories !== "" &&
      (typeof recipe.calories !== "number" || recipe.calories > Number(maxCalories)))
      return false;

    if (selectedTags.size && !Array.from(selectedTags).every(function(tag) {
      return tags.includes(tag);
    })) return false;

    if (allergenQuery && allergens.includes(allergenQuery)) return false;

    if (selectedOnly && !selectedRecipes.has(recipeKey(recipe))) return false;

    return true;
  }).sort(function(a, b) {
    if (sortMode === "prep") return (a.prepTime || Infinity) - (b.prepTime || Infinity);
    if (sortMode === "calories") return (a.calories || Infinity) - (b.calories || Infinity);
    if (sortMode === "name") return String(a.name || "").localeCompare(String(b.name || ""));
    return 0;
  });
}

function updateMenu() {
  const recipes = Array.isArray(menuData.recipes) ? menuData.recipes : [];
  const filtered = getFilteredRecipes();

  const grid = root.querySelector(".grid");
  const summary = root.querySelector(".summary");
  const empty = root.querySelector(".empty");
  if (!grid || !summary || !empty) return;

  grid.replaceChildren();
  filtered.forEach(function(recipe) {
    grid.append(fillCard(recipe, { selection: true }));
  });

  text(summary, filtered.length + " recette(s) affichée(s) sur " +
    recipes.length + " · " + selectedRecipes.size + " sélectionnée(s)");

  empty.hidden = filtered.length !== 0;
  grid.hidden = filtered.length === 0;
}

function renderMenu(data) {
  menuData = data && typeof data === "object" ? data : {};
  root.replaceChildren();

  const week = typeof menuData.week_id === "string" ? menuData.week_id : "";
  if (week) root.append(element("h1", "week", "Menu · " + week));

  const recipes = Array.isArray(menuData.recipes) ? menuData.recipes : [];
  if (!recipes.length) {
    root.append(element("p", "empty", "Aucune recette disponible."));
    return;
  }

  const toolbar = element("section", "toolbar");
  toolbar.append(element("div", "filter-heading"));
  text(toolbar.firstChild.appendChild(element("h2")), "Filtrer les recettes");

  const reset = element("button", "text-button", "Réinitialiser les filtres");
  reset.type = "button";
  reset.addEventListener("click", function() {
    searchQuery = "";
    maxPrep = "";
    maxCalories = "";
    selectedTags.clear();
    excludedAllergens = "";
    selectedOnly = false;
    sortMode = "default";
    renderMenuControls();
    updateMenu();
  });
  toolbar.firstChild.append(reset);

  const controls = element("div", "filters");
  const search = element("input");
  search.type = "search";
  search.id = "recipe-search";
  search.placeholder = "Nom, description, tag…";
  search.value = searchQuery;
  search.addEventListener("input", function() {
    searchQuery = search.value;
    updateMenu();
  });
  controls.append(createField("Rechercher", search));

  const prep = createSelect("max-prep", [
    { value: "", label: "Tous les temps" },
    { value: "15", label: "15 min maximum" },
    { value: "20", label: "20 min maximum" },
    { value: "30", label: "30 min maximum" },
    { value: "45", label: "45 min maximum" },
    { value: "60", label: "60 min maximum" }
  ]);
  prep.value = maxPrep;
  prep.addEventListener("change", function() {
    maxPrep = prep.value;
    updateMenu();
  });
  controls.append(createField("Préparation", prep));

  const calories = element("input");
  calories.type = "number";
  calories.id = "max-calories";
  calories.min = "1";
  calories.placeholder = "Ex. 700";
  calories.value = maxCalories;
  calories.addEventListener("input", function() {
    maxCalories = calories.value;
    updateMenu();
  });
  controls.append(createField("Calories max. / portion", calories));

  const sort = createSelect("sort-recipes", [
    { value: "default", label: "Ordre d'origine" },
    { value: "prep", label: "Temps croissant" },
    { value: "calories", label: "Calories croissantes" },
    { value: "name", label: "Nom A → Z" }
  ]);
  sort.value = sortMode;
  sort.addEventListener("change", function() {
    sortMode = sort.value;
    updateMenu();
  });
  controls.append(createField("Trier par", sort));

  const allergen = element("input");
  allergen.type = "search";
  allergen.id = "exclude-allergens";
  allergen.placeholder = "Ex. arachides";
  allergen.value = excludedAllergens;
  allergen.addEventListener("input", function() {
    excludedAllergens = allergen.value;
    updateMenu();
  });
  controls.append(createField("Exclure un allergène", allergen));

  toolbar.append(controls);

  const allTags = Array.from(new Set(
    recipes.reduce(function(result, recipe) {
      return result.concat(recipeTags(recipe));
    }, [])
  )).sort(function(a, b) { return a.localeCompare(b); });

  if (allTags.length) {
    const tagSection = element("div", "toolbar");
    tagSection.append(element("div", "filter-title", "Tags (tous les tags sélectionnés)"));
    const tagList = element("div", "tag-filters");
    allTags.forEach(function(tag, index) {
      const label = element("label", "tag-option");
      const checkbox = element("input");
      checkbox.type = "checkbox";
      checkbox.id = "tag-" + index;
      checkbox.checked = selectedTags.has(tag);
      checkbox.addEventListener("change", function() {
        if (checkbox.checked) selectedTags.add(tag);
        else selectedTags.delete(tag);
        updateMenu();
      });
      label.append(checkbox, document.createTextNode(tag));
      tagList.append(label);
    });
    tagSection.append(tagList);
    toolbar.append(tagSection);
  }

  const toggleRow = element("div", "toggle-row");
  const selectedLabel = element("label", "check-label");
  const selectedCheckbox = element("input");
  selectedCheckbox.type = "checkbox";
  selectedCheckbox.checked = selectedOnly;
  selectedCheckbox.addEventListener("change", function() {
    selectedOnly = selectedCheckbox.checked;
    updateMenu();
  });
  selectedLabel.append(selectedCheckbox, document.createTextNode("Afficher uniquement la sélection"));
  toggleRow.append(selectedLabel);
  toggleRow.append(element("span", "summary", ""));
  toolbar.append(toggleRow);

  const summary = element("p", "summary");
  const empty = element("p", "empty", "Aucune recette ne correspond aux filtres.");
  empty.hidden = true;
  const grid = element("div", "grid");

  root.append(toolbar, summary, empty, grid);
  updateMenu();
}

/* Reconstruit les contrôles après une réinitialisation des filtres. */
function renderMenuControls() {
  renderMenu(menuData);
}

/* Fiche recette : présentation, ingrédients et étapes sont des sections séparées. */
function listSection(title, items, ordered, className) {
  const section = element("section", "section");
  section.append(element("h2", "", title));
  const list = element(ordered ? "ol" : "ul", className || "");
  const values = Array.isArray(items) ? items : [];

  if (!values.length) {
    list.append(element("li", "", "Non renseigné"));
  } else {
    values.forEach(function(value) {
      list.append(element("li", "", value));
    });
  }

  section.append(list);
  return section;
}

function renderRecipe(data) {
  root.replaceChildren();
  const recipe = data && typeof data === "object" ? data : {};
  const container = element("div", "single");

  const header = element("div", "recipe-header");
  const card = fillCard(recipe, { selection: false });
  card.classList.add("card");
  header.append(card);

  const layout = element("div", "recipe-layout");
  layout.append(listSection("Ingrédients", recipe.ingredients, false, "ingredients-list"));
  layout.append(listSection("Préparation", recipe.steps, true, "step-list"));

  container.append(header, layout);
  root.append(container);
}

const app = new App({ name: ${JSON.stringify(appName)}, version: "1.1.0" });
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
