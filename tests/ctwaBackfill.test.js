import test from "node:test";
import assert from "node:assert/strict";
import { shouldRunCtwaBackfill } from "../src/ctwaBackfill.js";

test("skips backfill by default", () => {
  assert.equal(shouldRunCtwaBackfill({ env: {} }), false);
});

test("enables backfill when the explicit query flag is provided", () => {
  assert.equal(shouldRunCtwaBackfill({ query: { ctwaBackfill: "1" }, env: {} }), true);
  assert.equal(shouldRunCtwaBackfill({ query: { ctwaBackfill: "true" }, env: {} }), true);
});

test("enables backfill when the environment flag is set", () => {
  assert.equal(shouldRunCtwaBackfill({ env: { CTWA_BACKFILL_ENABLED: "true" } }), true);
  assert.equal(shouldRunCtwaBackfill({ env: { CTWA_BACKFILL_ENABLED: "1" } }), true);
});
