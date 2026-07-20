import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

test("daily Meta Ads metrics are isolated by platform account", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "yoga-meta-ads-store-"));
  process.env.CRM_DATA_DIR = dataDir;
  const store = await import(`../src/store.js?meta-accounts=${Date.now()}`);

  store.upsertMetaAdsDailyMetrics("2026-07-18", {
    adAccountId: "act_usd",
    adAccountName: "Ofiprof",
    accountId: "zernio-meta",
    spend: 100,
    currency: "USD",
    usdArsRate: 1550,
  });
  store.upsertMetaAdsDailyMetrics("2026-07-18", {
    adAccountId: "act_ars",
    adAccountName: "Ofiprof en pesos",
    accountId: "zernio-meta",
    spend: 120000,
    currency: "ARS",
  });

  const usd = store.getMetaAdsDailyMetrics("2026-07-18", "act_usd");
  const ars = store.getMetaAdsDailyMetrics("2026-07-18", "act_ars");
  assert.equal(usd.spend, 100);
  assert.equal(usd.usdArsRate, 1550);
  assert.equal(ars.spend, 120000);
  assert.deepEqual(
    store.listMetaAdsDailyMetricsRange({ from: "2026-07-18", to: "2026-07-18", adAccountId: "act_usd" }).map((row) => row.adAccountId),
    ["act_usd"]
  );
});

test("legacy daily metrics remain unassigned until refreshed from a known account", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "yoga-meta-ads-migration-"));
  const databasePath = path.join(dataDir, "ofiprof-crm.sqlite");
  const legacyDb = new DatabaseSync(databasePath);
  legacyDb.exec(`
    CREATE TABLE meta_ads_daily_metrics (
      date TEXT PRIMARY KEY,
      account_id TEXT NOT NULL DEFAULT '',
      spend REAL NOT NULL DEFAULT 0,
      impressions INTEGER NOT NULL DEFAULT 0,
      clicks INTEGER NOT NULL DEFAULT 0,
      cpc REAL NOT NULL DEFAULT 0,
      cpm REAL NOT NULL DEFAULT 0,
      conversions INTEGER NOT NULL DEFAULT 0,
      purchase_value REAL NOT NULL DEFAULT 0,
      roas REAL NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'zernio',
      raw_json TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );
    INSERT INTO meta_ads_daily_metrics (date, spend, currency, updated_at)
    VALUES ('2026-07-17', 90, 'USD', '2026-07-18T00:00:00.000Z');
  `);
  legacyDb.close();

  process.env.CRM_DATA_DIR = dataDir;
  const store = await import(`../src/store.js?meta-migration=${Date.now()}`);
  const migratedDb = new DatabaseSync(databasePath);
  const columns = migratedDb.prepare("PRAGMA table_info(meta_ads_daily_metrics)").all();
  const legacyRow = migratedDb.prepare("SELECT ad_account_id AS adAccountId, spend FROM meta_ads_daily_metrics WHERE date = '2026-07-17'").get();

  assert.ok(columns.some((column) => column.name === "ad_account_id"));
  assert.equal(legacyRow.adAccountId, "");
  assert.equal(store.getMetaAdsDailyMetrics("2026-07-17", "act_usd"), null);
  assert.deepEqual(store.listUnassignedMetaAdsMetrics().map((row) => row.date), ["2026-07-17"]);

  store.upsertMetaAdsDailyMetrics("2026-07-17", {
    adAccountId: "act_usd",
    adAccountName: "Ofiprof",
    spend: 91,
    currency: "USD",
    usdArsRate: 1550,
  });
  assert.equal(store.deleteUnassignedMetaAdsDailyMetrics("2026-07-17"), true);
  assert.deepEqual(store.listUnassignedMetaAdsMetrics(), []);
  assert.equal(store.getMetaAdsDailyMetrics("2026-07-17", "act_usd").spend, 91);
  assert.equal(store.deleteMetaAdsDailyMetrics("2026-07-17", "act_usd"), true);
  assert.equal(store.getMetaAdsDailyMetrics("2026-07-17", "act_usd"), null);
  migratedDb.close();
});
