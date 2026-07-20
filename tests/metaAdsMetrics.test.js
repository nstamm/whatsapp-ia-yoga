import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_META_AD_ACCOUNT_ID,
  hasMetaAdsActivity,
  metaSpendInArs,
  primaryMetaAdAccountId,
  selectPrimaryMetaAdAccount,
  shouldReplaceLegacyMetaAdsMetrics,
} from "../src/metaAdsPolicy.js";

function shiftDateKey(dateKey, days) {
  const date = new Date(`${dateKey}T00:00:00`);
  date.setDate(date.getDate() + days);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function isFutureDateKey(dateKey, todayKey) {
  return String(dateKey ?? "") > todayKey;
}

function isRecentMetaAdsDate(dateKey, todayKey) {
  const key = String(dateKey ?? "");
  return key >= shiftDateKey(todayKey, -1) && key <= todayKey;
}

function isEmptyMetaAdsMetrics(metrics = {}) {
  return !(
    Number(metrics.spend) > 0 ||
    Number(metrics.impressions) > 0 ||
    Number(metrics.clicks) > 0 ||
    Number(metrics.conversions) > 0 ||
    Number(metrics.purchaseValue) > 0
  );
}

function shouldPersistMetaAdsMetrics({ dateKey, todayKey, hasTimelineRow, metrics }) {
  if (isFutureDateKey(dateKey, todayKey)) return false;
  if (!hasTimelineRow && isRecentMetaAdsDate(dateKey, todayKey) && isEmptyMetaAdsMetrics(metrics)) return false;
  return true;
}

test("future Meta Ads dates should not be persisted as zero spend", () => {
  assert.equal(
    shouldPersistMetaAdsMetrics({
      dateKey: "2026-07-12",
      todayKey: "2026-07-11",
      hasTimelineRow: false,
      metrics: { spend: 0, impressions: 0, clicks: 0, conversions: 0, purchaseValue: 0 },
    }),
    false
  );
});

test("recent missing Meta Ads rows should be treated as unavailable, not valid zero spend", () => {
  assert.equal(
    shouldPersistMetaAdsMetrics({
      dateKey: "2026-07-10",
      todayKey: "2026-07-11",
      hasTimelineRow: false,
      metrics: { spend: 0, impressions: 0, clicks: 0, conversions: 0, purchaseValue: 0 },
    }),
    false
  );
});

test("recent real zero timeline rows can still be persisted", () => {
  assert.equal(
    shouldPersistMetaAdsMetrics({
      dateKey: "2026-07-10",
      todayKey: "2026-07-11",
      hasTimelineRow: true,
      metrics: { spend: 0, impressions: 0, clicks: 0, conversions: 0, purchaseValue: 0 },
    }),
    true
  );
});

test("older empty Meta Ads rows may be persisted for historical backfill", () => {
  assert.equal(
    shouldPersistMetaAdsMetrics({
      dateKey: "2026-07-08",
      todayKey: "2026-07-11",
      hasTimelineRow: false,
      metrics: { spend: 0, impressions: 0, clicks: 0, conversions: 0, purchaseValue: 0 },
    }),
    true
  );
});

test("recent tree fallback with non-zero spend should be persisted", () => {
  assert.equal(
    shouldPersistMetaAdsMetrics({
      dateKey: "2026-07-10",
      todayKey: "2026-07-11",
      hasTimelineRow: false,
      metrics: { spend: 1200, impressions: 100, clicks: 4, conversions: 0, purchaseValue: 0 },
    }),
    true
  );
});

test("Ofiprof USD is the only default Meta Ads account", () => {
  const accounts = [
    { id: "act_27791723490423883", name: "Ofiprof en pesos", currency: "ARS" },
    { id: DEFAULT_META_AD_ACCOUNT_ID, name: "Ofiprof", currency: "USD" },
  ];

  assert.equal(primaryMetaAdAccountId({}), DEFAULT_META_AD_ACCOUNT_ID);
  assert.deepEqual(selectPrimaryMetaAdAccount(accounts), accounts[1]);
  assert.equal(selectPrimaryMetaAdAccount(accounts, "act_27791723490423883"), null);
  assert.equal(selectPrimaryMetaAdAccount(accounts, "act_missing"), null);
});

test("USD spend uses the stored daily rate for financial calculations", () => {
  assert.equal(metaSpendInArs({ spend: 100, currency: "USD", usdArsRate: 1550 }, 1600), 155000);
  assert.equal(metaSpendInArs({ spend: 100, currency: "USD" }, 1600), 160000);
  assert.equal(metaSpendInArs({ spend: 100, currency: "ARS", usdArsRate: 1550 }, 1600), 100);
});

test("legacy spend is removed only after a non-empty identified replacement", () => {
  const legacy = { spend: 90, impressions: 1000 };
  assert.equal(hasMetaAdsActivity(legacy), true);
  assert.equal(shouldReplaceLegacyMetaAdsMetrics(legacy, { spend: 0, impressions: 0 }), false);
  assert.equal(shouldReplaceLegacyMetaAdsMetrics(legacy, { spend: 91, impressions: 1100 }), true);
  assert.equal(shouldReplaceLegacyMetaAdsMetrics({ spend: 0 }, { spend: 0 }), true);
  assert.equal(shouldReplaceLegacyMetaAdsMetrics(legacy, null), false);
});
