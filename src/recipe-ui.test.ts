import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { menuWeekLabel } from "./recipe-ui.js";

describe("menuWeekLabel", () => {
  it("formats an ISO week as a French Monday–Sunday range", () => {
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
