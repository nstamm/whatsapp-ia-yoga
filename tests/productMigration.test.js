import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

test("fantasia-v1 replaces persisted product settings and resets commercial contact state", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "fantasia-product-migration-"));
  process.env.CRM_DATA_DIR = dataDir;
  const initialStore = await import(`../src/store.js?product-migration-setup=${Date.now()}`);
  const phoneNumber = "+5491100011111";
  initialStore.recordPayment(phoneNumber, {
    productCode: "legacy-product",
    productName: "Legacy product",
    amount: 12345,
  });

  const db = new DatabaseSync(path.join(dataDir, "ofiprof-crm.sqlite"));
  db.prepare("UPDATE settings SET value = 'legacy-v1' WHERE key = 'product_config_version'").run();
  db.prepare("UPDATE settings SET value = 'Legacy prompt' WHERE key = 'master_prompt'").run();
  db.prepare("UPDATE settings SET value = 'pixel-production' WHERE key = 'meta_ads_destination_id'").run();
  db.prepare("UPDATE settings SET value = '777' WHERE key = 'openai_max_tokens'").run();
  db.prepare(
    `UPDATE contacts
     SET greeting_sent = 1,
         greeting_audio_sent = 1,
         product_link_sent = 1,
         promo_sent = 1,
         payment_alias_sent = 1,
         payment_alias_note_sent = 1,
         fantasia_video_sent = 1
     WHERE phone_number = ?`
  ).run(phoneNumber);
  db.close();

  const migratedStore = await import(`../src/store.js?product-migration-run=${Date.now()}`);
  const contact = migratedStore.getContact(phoneNumber);

  assert.equal(migratedStore.getSetting("product_config_version"), "fantasia-v1");
  assert.match(migratedStore.getSetting("master_prompt"), /Fantasía Color PRO/);
  assert.equal(migratedStore.getSetting("payment_alias"), "pagos.ofiprof");
  assert.match(migratedStore.getSetting("payment_alias_note"), /Nicolás Stamm/);
  assert.equal(migratedStore.getSetting("meta_ads_destination_id"), "pixel-production");
  assert.equal(migratedStore.getSetting("openai_max_tokens"), "777");
  assert.equal(contact.paid, 0);
  assert.equal(contact.greeting_sent, 0);
  assert.equal(contact.greeting_audio_sent, 0);
  assert.equal(contact.product_link_sent, 0);
  assert.equal(contact.promo_sent, 0);
  assert.equal(contact.payment_alias_sent, 0);
  assert.equal(contact.payment_alias_note_sent, 0);
  assert.equal(contact.fantasia_video_sent, 0);
  assert.equal(migratedStore.listPayments().length, 1);
});

test("existing contacts that already received the alias are not retrofitted with the new media batch", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "fantasia-second-batch-migration-"));
  process.env.CRM_DATA_DIR = dataDir;
  const store = await import(`../src/store.js?second-batch-setup=${Date.now()}`);
  const phoneNumber = "+5491100022222";
  store.ensureContact(phoneNumber, { conversationId: "conversation-existing-alias" });

  const db = new DatabaseSync(path.join(dataDir, "ofiprof-crm.sqlite"));
  db.prepare("UPDATE settings SET value = 'legacy-second-batch' WHERE key = 'second_batch_config_version'").run();
  db.prepare(
    `UPDATE contacts
     SET payment_alias_sent = 1,
         payment_alias_note_sent = 0,
         fantasia_video_sent = 0
     WHERE phone_number = ?`
  ).run(phoneNumber);
  db.close();

  const migratedStore = await import(`../src/store.js?second-batch-run=${Date.now()}`);
  const contact = migratedStore.getContact(phoneNumber);
  assert.equal(contact.payment_alias_sent, 1);
  assert.equal(contact.payment_alias_note_sent, 1);
  assert.equal(contact.fantasia_video_sent, 1);
  assert.equal(migratedStore.getSetting("second_batch_config_version"), "fantasia-second-batch-v1");
});

test("a direct product upgrade resets legacy alias delivery before enabling the Fantasía media batch", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "fantasia-direct-product-migration-"));
  process.env.CRM_DATA_DIR = dataDir;
  const store = await import(`../src/store.js?direct-product-setup=${Date.now()}`);
  const phoneNumber = "+5491100033333";
  store.ensureContact(phoneNumber, { conversationId: "conversation-legacy-product" });

  const db = new DatabaseSync(path.join(dataDir, "ofiprof-crm.sqlite"));
  db.prepare("UPDATE settings SET value = 'legacy-product' WHERE key = 'product_config_version'").run();
  db.prepare("UPDATE settings SET value = 'legacy-second-batch' WHERE key = 'second_batch_config_version'").run();
  db.prepare("UPDATE contacts SET payment_alias_sent = 1 WHERE phone_number = ?").run(phoneNumber);
  db.close();

  const migratedStore = await import(`../src/store.js?direct-product-run=${Date.now()}`);
  const contact = migratedStore.getContact(phoneNumber);
  assert.equal(contact.payment_alias_sent, 0);
  assert.equal(contact.payment_alias_note_sent, 0);
  assert.equal(contact.fantasia_video_sent, 0);
});
