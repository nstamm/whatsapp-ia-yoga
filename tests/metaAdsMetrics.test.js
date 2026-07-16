import test from "node:test";
import assert from "node:assert/strict";

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
