import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

test("reverting a false conversion removes its income and returns the contact to unpaid", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "yoga-payment-reversal-"));
  process.env.CRM_DATA_DIR = dataDir;
  const store = await import(`../src/store.js?payment-reversal=${Date.now()}`);
  const phoneNumber = "+5491100012345";
  const paidAt = "2026-07-20T10:00:00.000Z";

  store.recordPayment(phoneNumber, { amount: 14999, paidAt });
  assert.equal(store.listPayments().length, 1);
  assert.equal(store.listConversationSummaries({ limit: 1, prioritizeConversions: true })[0].paid, 1);

  const reversal = store.reverseLatestPayment(phoneNumber);
  const conversation = store.listConversationSummaries({ limit: 1 })[0];

  assert.deepEqual(reversal, { paymentId: 1, amount: 14999, paidAt, stillPaid: false });
  assert.equal(store.listPayments().length, 0);
  assert.equal(conversation.paid, 0);
  assert.equal(conversation.paymentCount, 0);
  assert.equal(conversation.paymentTotal, 0);
  assert.equal(store.reverseLatestPayment(phoneNumber), null);
});

test("reverting the latest payment keeps a contact converted when an earlier payment remains", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "yoga-payment-reversal-multiple-"));
  process.env.CRM_DATA_DIR = dataDir;
  const store = await import(`../src/store.js?payment-reversal-multiple=${Date.now()}`);
  const phoneNumber = "+5491100056789";

  store.recordPayment(phoneNumber, { amount: 4999, paidAt: "2026-07-19T10:00:00.000Z" });
  store.recordPayment(phoneNumber, { amount: 14999, paidAt: "2026-07-20T10:00:00.000Z" });
  const reversal = store.reverseLatestPayment(phoneNumber);
  const conversation = store.listConversationSummaries({ limit: 1, prioritizeConversions: true })[0];

  assert.equal(reversal.amount, 14999);
  assert.equal(reversal.stillPaid, true);
  assert.equal(store.listPayments().length, 1);
  assert.equal(conversation.paid, 1);
  assert.equal(conversation.paymentTotal, 4999);
});

test("payment reporting uses Argentina business-day bounds instead of the server day", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "yoga-payment-business-day-"));
  process.env.CRM_DATA_DIR = dataDir;
  const store = await import(`../src/store.js?payment-business-day=${Date.now()}`);

  store.recordPayment("+5491100099991", { amount: 15000, paidAt: "2026-07-21T00:29:55.000Z", conversationId: "conversation-arg-1" });
  store.recordPayment("+5491100099992", { amount: 15000, paidAt: "2026-07-21T03:00:00.000Z", conversationId: "conversation-arg-2" });

  assert.equal(store.listPayments({ from: "2026-07-20", to: "2026-07-20" }).length, 1);
  assert.equal(store.listPayments({ from: "2026-07-21", to: "2026-07-21" }).length, 1);
  assert.equal(store.listRecentPaidContactsMissingCtwaAttribution({ since: "2026-07-20T00:00:00.000Z" }).length, 2);
});
