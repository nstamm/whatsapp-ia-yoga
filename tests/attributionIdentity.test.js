import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

test("canonical contact keys preserve attribution across phone formats", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "yoga-attribution-"));
  process.env.CRM_DATA_DIR = dataDir;
  const store = await import(`../src/store.js?attribution=${Date.now()}`);
  const plusPhone = "+5491112345678";
  const barePhone = "5491112345678";
  const delayedPhone = "+5491199999999";
  const capturedAt = "2026-07-16T12:00:00.000Z";

  store.ensureContact(plusPhone);
  store.ensureContact(delayedPhone);
  store.saveContactCtwaAttribution(plusPhone, { ctwaSourceId: "ad-123", ctwaCapturedAt: capturedAt });
  store.saveContactCtwaAttribution(plusPhone, { ctwaSourceId: "ad-456", ctwaCapturedAt: "2026-07-20T12:00:00.000Z" });
  store.addMessage(barePhone, "user", "Quiero información");
  store.recordPayment(barePhone, { amount: 4999, paidAt: capturedAt });

  const conversations = store.listCtwaAttributedConversations({ from: "2026-07-16", to: "2026-07-16" });
  assert.equal(conversations.length, 1);
  assert.equal(conversations[0].phoneNumber, plusPhone);
  assert.equal(conversations[0].leadReplyCount, 1);
  assert.equal(conversations[0].paymentTotal, 4999);
  assert.equal(conversations[0].ctwaCapturedAt, capturedAt);

  const payments = store.listCtwaAttributedPayments({ from: "2026-07-16", to: "2026-07-16" });
  assert.equal(payments.length, 1);
  assert.equal(payments[0].attributedPhoneNumber, plusPhone);

  const dbPath = path.join(dataDir, "ofiprof-crm.sqlite");
  const db = new DatabaseSync(dbPath);
  assert.equal(db.prepare("SELECT attribution_at AS attributionAt FROM contacts WHERE phone_number = ?").get(plusPhone).attributionAt, capturedAt);
  store.ensureContact("ig:legacy-user", { accountId: "account-1", channel: "instagram" });
  assert.equal(store.resolveChannelContactId("instagram", "account-1", "legacy-user"), "ig:legacy-user");
  assert.equal(store.resolveChannelContactId("instagram", "account-2", "legacy-user"), "ig:account-2:legacy-user");
  const socialKey = db.prepare("SELECT contact_key AS contactKey FROM contacts WHERE phone_number = 'ig:legacy-user'").get().contactKey;
  store.getHistory("ig:legacy-user");
  store.addMessage("ig:legacy-user", "user", "Hola", { accountId: "account-1" });
  store.recordPayment("ig:legacy-user", { amount: 4999 });
  assert.equal(db.prepare("SELECT contact_key AS contactKey FROM contacts WHERE phone_number = 'ig:legacy-user'").get().contactKey, socialKey);
  assert.equal(db.prepare("SELECT contact_key AS contactKey FROM messages WHERE phone_number = 'ig:legacy-user'").get().contactKey, socialKey);
  assert.equal(db.prepare("SELECT contact_key AS contactKey FROM payments WHERE phone_number = 'ig:legacy-user'").get().contactKey, socialKey);
  const indexes = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((row) => row.name));
  assert.equal(indexes.has("idx_contacts_ctwa_attribution"), true);
  assert.equal(indexes.has("idx_contacts_attribution_date"), true);
  assert.equal(indexes.has("idx_messages_contact_role_at"), true);
  assert.equal(indexes.has("idx_payments_contact_paid_at"), true);

  db.exec("UPDATE contacts SET contact_key = ''; UPDATE messages SET contact_key = ''; UPDATE payments SET contact_key = '';");
  const migratedStore = await import(`../src/store.js?backfill=${Date.now()}`);
  assert.equal(db.prepare("SELECT COUNT(*) AS total FROM contacts WHERE contact_key = ''").get().total, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS total FROM messages WHERE contact_key = ''").get().total, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS total FROM payments WHERE contact_key = ''").get().total, 0);
  assert.equal(db.prepare("SELECT attribution_at AS attributionAt FROM contacts WHERE phone_number = ?").get(delayedPhone).attributionAt, null);
  migratedStore.saveContactCtwaAttribution(delayedPhone, { ctwaSourceId: "ad-delayed", ctwaCapturedAt: "2026-07-25T12:00:00.000Z" });
  assert.equal(db.prepare("SELECT attribution_at AS attributionAt FROM contacts WHERE phone_number = ?").get(delayedPhone).attributionAt, "2026-07-25T12:00:00.000Z");
  db.close();
});
