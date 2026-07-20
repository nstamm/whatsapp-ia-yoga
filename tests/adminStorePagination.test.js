import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

test("conversation summaries filter and paginate inside SQLite", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "yoga-admin-store-"));
  process.env.CRM_DATA_DIR = dataDir;
  const store = await import(`../src/store.js?pagination=${Date.now()}`);
  const db = new DatabaseSync(path.join(dataDir, "ofiprof-crm.sqlite"));
  const insertContact = db.prepare(
    "INSERT INTO contacts (phone_number, name, channel, paid, handoff, product_link_sent, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  );
  const insertMessage = db.prepare(
    "INSERT INTO messages (phone_number, role, content, at) VALUES (?, 'user', ?, ?)"
  );
  const insertPayment = db.prepare(
    "INSERT INTO payments (phone_number, product_code, product_name, amount, paid_at, created_at) VALUES (?, 'base', 'Kit Yoga Pro', 4999, ?, ?)"
  );

  db.exec("BEGIN");
  for (let index = 0; index < 120; index += 1) {
    const phone = `+54911000${String(index).padStart(3, "0")}`;
    const timestamp = new Date(Date.UTC(2026, 6, 16, 12, 0, index)).toISOString();
    const paid = index % 5 === 0 ? 1 : 0;
    const channel = ["whatsapp", "instagram", "facebook"][index % 3];
    insertContact.run(phone, `Lead ${index}`, channel, paid, index % 7 === 0 ? 1 : 0, index % 11 === 0 ? 1 : 0, timestamp, timestamp);
    insertMessage.run(phone, `consulta yoga ${index}`, timestamp);
    if (index % 3 === 0) insertMessage.run(phone, "segunda respuesta", timestamp);
    if (paid) insertPayment.run(phone, timestamp, timestamp);
  }
  db.exec("COMMIT");

  assert.equal(store.countConversationSummaries(), 120);
  const firstPage = store.listConversationSummaries({ limit: 50 });
  const secondPage = store.listConversationSummaries({ limit: 50, offset: 50 });
  const lastPage = store.listConversationSummaries({ limit: 50, offset: 100 });
  assert.equal(firstPage.length, 50);
  assert.equal(secondPage.length, 50);
  assert.equal(lastPage.length, 20);
  assert.equal(new Set([...firstPage, ...secondPage, ...lastPage].map((row) => row.phoneNumber)).size, 120);

  assert.equal(store.countConversationSummaries({ filter: "converted" }), 24);
  assert.equal(store.countConversationSummaries({ filter: "interested" }), 40);
  assert.equal(store.countConversationSummaries({ quickFilter: "instagram" }), 40);
  assert.equal(store.countConversationSummaries({ quickFilter: "interest-2" }), 40);
  assert.equal(store.countConversationSummaries({ quickFilter: "released" }), 11);
  assert.equal(store.countConversationSummaries({ search: "Lead 117" }), 1);
  assert.equal(store.listConversationSummaries({ search: "consulta yoga 42", limit: 50 })[0].name, "Lead 42");
  assert.equal(store.countConversationSummaries({ search: "cliente pago" }), 24);
  assert.equal(store.countConversationSummaries({ search: "Instagram" }), 40);
  assert.equal(store.countConversationSummaries({ search: "interesado" }), 40);
  assert.equal(store.countConversationSummaries({ search: "sin recordatorio" }), 120);
  assert.equal(store.countConversationSummaries({ search: "Lead 117 sin pago" }), 1);
  assert.equal(store.countConversationSummaries({ search: "%" }), 0);
  const firstPayments = store.listPayments({ limit: 10 });
  const secondPayments = store.listPayments({ limit: 10, offset: 10 });
  assert.equal(firstPayments.length, 10);
  assert.equal(secondPayments.length, 10);
  assert.equal(new Set([...firstPayments, ...secondPayments].map((payment) => payment.id)).size, 20);

  db.close();
});

test("dashboard summaries prioritize the latest conversions before recent activity", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "yoga-dashboard-conversions-"));
  process.env.CRM_DATA_DIR = dataDir;
  const store = await import(`../src/store.js?dashboard-conversions=${Date.now()}`);
  const db = new DatabaseSync(path.join(dataDir, "ofiprof-crm.sqlite"));
  const insertContact = db.prepare(
    "INSERT INTO contacts (phone_number, name, paid, paid_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
  );
  const oldPayment = "2026-07-10T09:00:00.000Z";
  const latestPayment = "2026-07-16T15:00:00.000Z";
  const latestActivity = "2026-07-17T20:00:00.000Z";

  insertContact.run("+549110000001", "Latest conversion", 1, latestPayment, oldPayment, oldPayment);
  insertContact.run("+549110000002", "Older conversion", 1, oldPayment, oldPayment, latestActivity);
  insertContact.run("+549110000003", "Latest conversation", 0, null, oldPayment, latestActivity);
  insertContact.run("+549110000004", "Older conversation", 0, null, oldPayment, oldPayment);

  const prioritized = store.listConversationSummaries({ limit: 4, prioritizeConversions: true });
  assert.deepEqual(prioritized.map((conversation) => conversation.name), [
    "Latest conversion",
    "Older conversion",
    "Latest conversation",
    "Older conversation",
  ]);

  const latestOnly = store.listConversationSummaries({ limit: 2 });
  assert.deepEqual(latestOnly.map((conversation) => conversation.name), [
    "Older conversion",
    "Latest conversation",
  ]);
  db.close();
});
