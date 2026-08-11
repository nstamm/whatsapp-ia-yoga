import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { contactHistoryCsv } from "../src/contactExport.js";

const dataDir = mkdtempSync(path.join(tmpdir(), "fantasia-contact-history-"));
process.env.CRM_DATA_DIR = dataDir;
const store = await import(`../src/store.js?contact-history=${Date.now()}`);
const db = new DatabaseSync(path.join(dataDir, "ofiprof-crm.sqlite"));

test("contact export lists only WhatsApp names and phone numbers", () => {
  store.ensureContact("+5491111111111", { channel: "whatsapp", name: "Ana, María" });
  store.ensureContact("+5491122222222", { channel: "whatsapp", name: "\t=FORMULA" });
  store.ensureContact("ig:user-1", { channel: "instagram", name: "Cuenta social" });

  const rows = store.listContactHistoryForExport();
  assert.deepEqual(rows, [
    { name: "Ana, María", phoneNumber: "+5491111111111" },
    { name: "\t=FORMULA", phoneNumber: "+5491122222222" },
  ]);

  const csv = contactHistoryCsv(rows);
  assert.equal(csv.startsWith("\uFEFFnombre,telefono\r\n"), true);
  assert.match(csv, /"Ana, María","'\+5491111111111"/);
  assert.match(csv, /"' =FORMULA","'\+5491122222222"/);
  assert.doesNotMatch(csv, /Cuenta social/);
});

test("purging contact history removes dependent data but preserves settings", () => {
  const phoneNumber = "+5491111111111";
  store.addMessage(phoneNumber, "user", "Hola");
  store.recordPayment(phoneNumber, { amount: 16999 });
  store.updateSettings({ meta_ads_destination_id: "pixel-preserved" });
  db.prepare(
    `INSERT INTO meta_conversion_events (event_id, phone_number, event_name, status, created_at, updated_at)
     VALUES ('event-contact-history', ?, 'Purchase', 'sent', ?, ?)`
  ).run(phoneNumber, new Date().toISOString(), new Date().toISOString());

  const deleted = store.purgeContactHistory();
  assert.equal(deleted.contacts, 3);
  assert.equal(deleted.messages, 1);
  assert.equal(deleted.payments, 1);
  assert.equal(deleted.conversionEvents, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM contacts").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM messages").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM payments").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM meta_conversion_events").get().count, 0);
  assert.equal(store.getSetting("meta_ads_destination_id"), "pixel-preserved");
  assert.equal(store.getSetting("product_config_version"), "fantasia-v1");
});

test("admin routes protect CSV export and require the destructive confirmation phrase", () => {
  const source = readFileSync(fileURLToPath(new URL("../src/index.js", import.meta.url)), "utf8");
  assert.match(source, /app\.get\("\/admin\/contacts\.csv", requireSensitiveAdmin/);
  assert.match(source, /app\.post\("\/admin\/contacts\/purge", requireSensitiveAdmin/);
  assert.match(source, /confirmation[\s\S]+BORRAR TODO/);
  assert.match(source, /contactHistoryMaintenance = true[\s\S]+await waitForContactOperations\(\)[\s\S]+purgeContactHistory\(\)/);
  assert.match(source, /return trackContactOperation\(\(\) => processIncomingMessageImpl\(options\)\)/);
  assert.match(source, /runAdminContactOperation\(res, \(\) => processManualPayment\(req, res\)\)/);
  assert.match(source, /trackContactOperation\(\(\) => sendPurchaseConversionForPayment/);
  assert.match(source, /deferredWebhookEvents\.push/);
  assert.match(source, /resumeDeferredWebhookEvents\(\)/);
  assert.match(source, /scheduleDebouncedMessage\(entry\)/);
});
