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
         payment_instructions_sent = 1,
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
  assert.match(migratedStore.getSetting("payment_instructions_text"), /enviás el comprobante/);
  assert.equal(migratedStore.getSetting("meta_ads_destination_id"), "pixel-production");
  assert.equal(migratedStore.getSetting("openai_max_tokens"), "777");
  assert.equal(contact.paid, 0);
  assert.equal(contact.greeting_sent, 0);
  assert.equal(contact.greeting_audio_sent, 0);
  assert.equal(contact.product_link_sent, 0);
  assert.equal(contact.promo_sent, 0);
  assert.equal(contact.payment_alias_sent, 0);
  assert.equal(contact.payment_alias_note_sent, 0);
  assert.equal(contact.payment_instructions_sent, 0);
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
         payment_instructions_sent = 0,
         fantasia_video_sent = 0
     WHERE phone_number = ?`
  ).run(phoneNumber);
  db.close();

  const migratedStore = await import(`../src/store.js?second-batch-run=${Date.now()}`);
  const contact = migratedStore.getContact(phoneNumber);
  assert.equal(contact.payment_alias_sent, 1);
  assert.equal(contact.payment_alias_note_sent, 1);
  assert.equal(contact.payment_instructions_sent, 1);
  assert.equal(contact.fantasia_video_sent, 1);
  assert.equal(migratedStore.getSetting("second_batch_config_version"), "fantasia-second-batch-v2");
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
  assert.equal(contact.payment_instructions_sent, 0);
  assert.equal(contact.fantasia_video_sent, 0);
});

test("second batch v2 updates the prior default landing and alias copy", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "fantasia-second-batch-copy-"));
  process.env.CRM_DATA_DIR = dataDir;
  await import(`../src/store.js?second-batch-copy-setup=${Date.now()}`);

  const db = new DatabaseSync(path.join(dataDir, "ofiprof-crm.sqlite"));
  db.prepare("UPDATE settings SET value = 'fantasia-second-batch-v1' WHERE key = 'second_batch_config_version'").run();
  db.prepare("UPDATE settings SET value = ? WHERE key = 'product_landing_text'").run(
    "Si querés ver más detalles y algunas muestras, podés mirar acá:\n{{product_landing_url}}"
  );
  db.prepare("UPDATE settings SET value = ? WHERE key = 'payment_alias_note'").run(
    "Acá te paso el alias, está a nombre de mi pareja Nicolás Stamm. 🙌"
  );
  db.close();

  const migratedStore = await import(`../src/store.js?second-batch-copy-run=${Date.now()}`);
  assert.match(migratedStore.getSetting("product_landing_text"), /te mando un video/i);
  assert.equal(migratedStore.getSetting("payment_alias_note"), "Acá te paso el alias de mi pareja Nicolás Stamm. 🙌");
  assert.match(migratedStore.getSetting("payment_instructions_text"), /te paso el link de descarga/);
});

test("offer copy v2 migrates known lines while preserving surrounding custom text", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "fantasia-offer-copy-"));
  process.env.CRM_DATA_DIR = dataDir;
  await import(`../src/store.js?offer-copy-setup=${Date.now()}`);

  const previousOffer = `Texto personalizado antes
✅ Más de 100 libros para colorear
✅ Más de 100 libros para colorear
✅ Más de 40 GB y 11.700 páginas
✅ Archivos de alta calidad, listos para imprimir
✅ Uso en iPad o tablet
✅ Papercraft, rutinas visuales y cuadernillos didácticos
✅ Más de 300 juegos imprimibles
✅ Actividades bíblicas para niños
✅ Actualizaciones y libros nuevos
Por WhatsApp te queda en un único pago de *$16.999* ✨
Texto personalizado después`.replaceAll("\n", "\r\n");
  const db = new DatabaseSync(path.join(dataDir, "ofiprof-crm.sqlite"));
  db.prepare("UPDATE settings SET value = 'fantasia-offer-copy-v1' WHERE key = 'offer_copy_version'").run();
  db.prepare("UPDATE settings SET value = ? WHERE key = 'initial_offer_text'").run(previousOffer);
  db.close();

  const migratedStore = await import(`../src/store.js?offer-copy-run=${Date.now()}`);
  const offer = migratedStore.getSetting("initial_offer_text");
  assert.match(offer, /^Texto personalizado antes/);
  assert.match(offer, /🧸 Todos los personajes favoritos de la infancia/);
  assert.match(offer, /🟢 Por WhatsApp/);
  assert.match(offer, /Texto personalizado después$/);
  assert.doesNotMatch(offer, /Actividades bíblicas|✅|Actualizaciones y libros nuevos/);
  assert.equal(migratedStore.getSetting("offer_copy_version"), "fantasia-offer-copy-v2");

  const retryDb = new DatabaseSync(path.join(dataDir, "ofiprof-crm.sqlite"));
  retryDb.prepare("UPDATE settings SET value = 'fantasia-offer-copy-v1' WHERE key = 'offer_copy_version'").run();
  retryDb.close();
  const retriedStore = await import(`../src/store.js?offer-copy-retry=${Date.now()}`);
  assert.equal(retriedStore.getSetting("initial_offer_text"), offer);
});

test("recovery flow migration installs the discount funnel without overwriting custom reminder copy", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "fantasia-recovery-flow-"));
  process.env.CRM_DATA_DIR = dataDir;
  await import(`../src/store.js?recovery-flow-setup=${Date.now()}`);
  const db = new DatabaseSync(path.join(dataDir, "ofiprof-crm.sqlite"));
  db.prepare("UPDATE settings SET value = 'legacy-recovery' WHERE key = 'recovery_flow_version'").run();
  db.prepare("UPDATE settings SET value = 'Recordatorio personalizado' WHERE key = 'reminder2_offer_text'").run();
  db.prepare("UPDATE settings SET value = ? WHERE key = 'master_prompt'").run(
    "Regla.\n- Si mencionás precio, siempre usá $16.999 por WhatsApp."
  );
  db.prepare("UPDATE settings SET value = ? WHERE key = 'next_reply_prompt'").run(
    "Respondé breve. Si mencionás precio, usá $16.999 por WhatsApp."
  );
  db.close();

  const migratedStore = await import(`../src/store.js?recovery-flow-run=${Date.now()}`);
  assert.equal(migratedStore.getSetting("reminder2_offer_text"), "Recordatorio personalizado");
  assert.match(migratedStore.getSetting("exclusive_offer_text"), /\*\$9\.999\*/);
  assert.match(migratedStore.getSetting("final_discount_text"), /\*\$6\.999\*/);
  assert.match(migratedStore.getSetting("master_prompt"), /último precio que el sistema ya ofreció/);
  assert.match(migratedStore.getSetting("next_reply_prompt"), /último precio que el sistema ya ofreció/);
  assert.equal(migratedStore.getSetting("recovery_flow_version"), "fantasia-recovery-v1");
});
