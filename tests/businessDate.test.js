import test from "node:test";
import assert from "node:assert/strict";
import { BUSINESS_TIME_ZONE, businessDateKey, businessDateRange, shiftBusinessDateKey } from "../src/businessDate.js";

test("uses Argentina's business day across the UTC midnight boundary", () => {
  assert.equal(BUSINESS_TIME_ZONE, "America/Argentina/Buenos_Aires");
  assert.equal(businessDateKey("2026-07-21T00:29:55.000Z"), "2026-07-20");
  assert.equal(businessDateKey("2026-07-21T03:00:00.000Z"), "2026-07-21");
});

test("creates UTC bounds for one complete Argentina business day", () => {
  const { start, end } = businessDateRange("2026-07-20");
  assert.equal(start.toISOString(), "2026-07-20T03:00:00.000Z");
  assert.equal(end.toISOString(), "2026-07-21T02:59:59.999Z");
});

test("shifts calendar keys without using the server timezone", () => {
  assert.equal(shiftBusinessDateKey("2026-07-20", 1), "2026-07-21");
  assert.equal(shiftBusinessDateKey("2026-03-01", -1), "2026-02-28");
});
