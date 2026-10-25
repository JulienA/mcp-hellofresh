import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deliveryDateLabel, MENU_UI_URI, menuWeekLabel, readRecipeUiResource } from "./recipe-ui.js";

describe("menuWeekLabel", () => {
  it("formats an ISO week as a French Monday–Sunday range", () => {
    assert.equal(menuWeekLabel("2026-W45"), "2 – 8 novembre 2026");
    assert.equal(menuWeekLabel("2026-W46"), "9 – 15 novembre 2026");
    assert.equal(menuWeekLabel("2026-W44"), "26 octobre – 1 novembre 2026");
  });

  it("keeps both months when the week crosses a year", () => {
    assert.equal(menuWeekLabel("2099-W01"), "29 décembre 2098 – 4 janvier 2099");
  });

  it("returns the original value when it is not an ISO week", () => {
    assert.equal(menuWeekLabel("cette semaine"), "cette semaine");
    assert.equal(menuWeekLabel("2026-W00"), "2026-W00");
    assert.equal(menuWeekLabel("2025-W53"), "2025-W53");
  });
});

describe("deliveryDateLabel", () => {
  it("formats the calendar day of a HelloFresh timestamp", () => {
    assert.equal(deliveryDateLabel("2026-10-31T12:00:00+0100"), "31 octobre 2026");
    assert.equal(deliveryDateLabel("2099-01-06T00:00:00+0000"), "6 janvier 2099");
  });

  it("returns empty when the value is not a date", () => {
    assert.equal(deliveryDateLabel(""), "");
    assert.equal(deliveryDateLabel("soon"), "");
    assert.equal(deliveryDateLabel("2026-13-40"), "");
  });
});

describe("menu HTML week helpers", () => {
  it("formats ISO weeks and delivery dates from week_id", () => {
    const html = readRecipeUiResource(MENU_UI_URI)?.text ?? "";
    const start = html.indexOf("function isoWeekLabel");
    const end = html.indexOf("function renderMenu");
    assert.ok(start >= 0 && end > start);
    const helpers = new Function(
      `${html.slice(start, end)}; return { isoWeekLabel, deliveryDateLabel, weekHeading, deliveryHeading };`
    )() as {
      isoWeekLabel: (weekId: string) => string;
      deliveryDateLabel: (value: string) => string;
      weekHeading: (data: object) => string;
      deliveryHeading: (data: object) => string;
    };
    assert.equal(helpers.isoWeekLabel("2026-W45"), "2 – 8 novembre 2026");
    assert.equal(helpers.isoWeekLabel("2026-W44"), "26 octobre – 1 novembre 2026");
    assert.equal(helpers.isoWeekLabel("2099-W01"), "29 décembre 2098 – 4 janvier 2099");
    assert.equal(helpers.weekHeading({ week_id: "2026-W45" }), "2 – 8 novembre 2026");
    assert.equal(helpers.deliveryDateLabel("2026-10-31T12:00:00+0100"), "31 octobre 2026");
    assert.equal(
      helpers.deliveryHeading({ delivery_date: "2026-10-31T12:00:00+0100" }),
      "31 octobre 2026"
    );
  });
});
