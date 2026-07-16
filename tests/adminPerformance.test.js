import test from "node:test";
import assert from "node:assert/strict";
import { adminSectionDataNeeds, buildAdminConversationQuery, createAsyncTtlCache, isFreshTimestamp, isValidDateKey, mapWithConcurrency } from "../src/adminPerformance.js";
import { listZernioAccounts } from "../src/zernio.js";

test("timestamp freshness rejects missing, expired, and future values", () => {
  const now = Date.parse("2026-07-16T12:00:00.000Z");
  assert.equal(isFreshTimestamp("2026-07-16T11:59:30.000Z", 60_000, now), true);
  assert.equal(isFreshTimestamp("2026-07-16T11:58:00.000Z", 60_000, now), false);
  assert.equal(isFreshTimestamp("2026-07-16T12:00:01.000Z", 60_000, now), false);
  assert.equal(isFreshTimestamp("", 60_000, now), false);
});

test("date keys reject calendar overflow", () => {
  assert.equal(isValidDateKey("2026-02-28"), true);
  assert.equal(isValidDateKey("2026-02-29"), false);
  assert.equal(isValidDateKey("2024-02-29"), true);
  assert.equal(isValidDateKey("2026-02-31"), false);
  assert.equal(isValidDateKey("2026-13-01"), false);
});

test("admin sections declare isolated data dependencies", () => {
  assert.deepEqual(adminSectionDataNeeds("flow"), {
    dashboard: false, ads: false, conversations: false, income: false, flow: true, settings: false, financial: false,
  });
  assert.equal(adminSectionDataNeeds("settings").settings, true);
  assert.equal(adminSectionDataNeeds("settings").financial, true);
  assert.equal(adminSectionDataNeeds("conversations").financial, false);
  assert.equal(adminSectionDataNeeds("dashboard").dashboard, true);
  assert.equal(adminSectionDataNeeds("income").income, true);
});

test("admin API and HTML can share global conversation filters", () => {
  assert.deepEqual(buildAdminConversationQuery({ convFilter: "pending", quickFilter: "yesterday", q: " Ana " }, "2026-07-16"), {
    filter: "pending",
    quickFilter: "yesterday",
    search: "Ana",
    activityFrom: "2026-07-15",
    activityTo: "2026-07-15",
  });
});

test("async TTL cache reuses values and coalesces concurrent loads", async () => {
  let now = 1_000;
  let loads = 0;
  const cache = createAsyncTtlCache({ ttlMs: 100, now: () => now });
  const loader = async () => ++loads;

  const [first, concurrent] = await Promise.all([
    cache.getOrLoad("ads", loader),
    cache.getOrLoad("ads", loader),
  ]);
  assert.deepEqual([first, concurrent], [1, 1]);
  assert.equal(await cache.getOrLoad("ads", loader), 1);

  now += 101;
  assert.equal(await cache.getOrLoad("ads", loader), 2);
  assert.equal(await cache.getOrLoad("ads", loader, { force: true }), 3);
});

test("forced refresh cannot be overwritten by an older request", async () => {
  const cache = createAsyncTtlCache({ ttlMs: 1000 });
  let resolveOld;
  let resolveFresh;
  const oldRequest = cache.getOrLoad("ads", () => new Promise((resolve) => { resolveOld = resolve; }));
  await Promise.resolve();
  const freshRequest = cache.getOrLoad("ads", () => new Promise((resolve) => { resolveFresh = resolve; }), { force: true });
  await Promise.resolve();

  resolveFresh("fresh");
  assert.equal(await freshRequest, "fresh");
  resolveOld("old");
  assert.equal(await oldRequest, "old");
  assert.equal(cache.peek("ads"), "fresh");
});

test("cache can reject transient error values", async () => {
  const cache = createAsyncTtlCache({ ttlMs: 1000 });
  let loads = 0;
  const options = { shouldCache: (value) => !value.error };

  assert.deepEqual(await cache.getOrLoad("ads", async () => ({ error: ++loads === 1 }), options), { error: true });
  assert.deepEqual(await cache.getOrLoad("ads", async () => ({ error: false }), options), { error: false });
  assert.deepEqual(cache.peek("ads"), { error: false });
});

test("cache evicts generation metadata with old values", async () => {
  const cache = createAsyncTtlCache({ ttlMs: 1000, maxEntries: 3 });
  for (let index = 0; index < 20; index += 1) await cache.getOrLoad(`key-${index}`, async () => index);
  assert.deepEqual(cache.stats(), { values: 3, pending: 0, generations: 3 });
});

test("cache removes generation metadata for failed and rejected loads", async () => {
  const cache = createAsyncTtlCache({ ttlMs: 1000, maxEntries: 3 });
  for (let index = 0; index < 20; index += 1) {
    await cache.getOrLoad(`rejected-${index}`, async () => ({ error: true }), { shouldCache: () => false });
    await assert.rejects(cache.getOrLoad(`failed-${index}`, async () => { throw new Error("failed"); }));
  }
  assert.deepEqual(cache.stats(), { values: 0, pending: 0, generations: 0 });
});

test("Zernio requests receive a bounded abort signal", async () => {
  const previousFetch = globalThis.fetch;
  const previousApiKey = process.env.ZERNIO_API_KEY;
  let signal;
  globalThis.fetch = async (_, options) => {
    signal = options.signal;
    return new Response(JSON.stringify({ accounts: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  process.env.ZERNIO_API_KEY = "test-key";

  try {
    await listZernioAccounts();
    assert.equal(signal instanceof AbortSignal, true);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousApiKey === undefined) delete process.env.ZERNIO_API_KEY;
    else process.env.ZERNIO_API_KEY = previousApiKey;
  }
});

test("concurrent mapping preserves order and respects its limit", async () => {
  let active = 0;
  let peak = 0;
  const values = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active -= 1;
    return value * 2;
  });

  assert.deepEqual(values, [2, 4, 6, 8, 10]);
  assert.equal(peak, 2);
});
