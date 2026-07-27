import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  INSTAGRAM_MESSAGE_LIMIT,
  isPermanentReminderSendError,
  reminderTextChunks,
} from "../src/reminderPolicy.js";

const dataDir = mkdtempSync(path.join(tmpdir(), "yoga-reminders-"));
process.env.CRM_DATA_DIR = dataDir;
const store = await import("../src/store.js");
const db = new DatabaseSync(path.join(dataDir, "ofiprof-crm.sqlite"));

function makeDownsellDue(phoneNumber) {
  store.ensureContact(phoneNumber, { conversationId: `conversation-${phoneNumber}` });
  db.prepare("UPDATE contacts SET reminder2_scheduled_at = ? WHERE phone_number = ?").run(
    "2026-07-11T10:00:00.000Z",
    phoneNumber
  );
}

test("scheduling a downsell never schedules the removed 6h reminder", () => {
  const phoneNumber = "+541111111111";
  const scheduledAt = store.scheduleDownsell(phoneNumber, "conversation-downsell");
  const contact = store.getContact(phoneNumber);

  assert.equal(contact.reminder_scheduled_at, null);
  assert.equal(contact.reminder2_scheduled_at, scheduledAt);
});

test("initial offer can be claimed only once", () => {
  const phoneNumber = "+541010101010";
  store.ensureContact(phoneNumber, { conversationId: "conversation-initial-offer" });
  assert.equal(store.claimInitialOffer(phoneNumber), true);
  assert.equal(store.claimInitialOffer(phoneNumber), false);
});

test("a due 23h downsell can be claimed only once", () => {
  const phoneNumber = "+542222222222";
  const now = new Date("2026-07-11T12:00:00.000Z");
  makeDownsellDue(phoneNumber);

  assert.equal(store.listDueReminder2s(now).length, 1);
  assert.equal(store.claimDueReminder2(phoneNumber, now), true);
  assert.equal(store.claimDueReminder2(phoneNumber, now), false);
  assert.equal(store.listDueReminder2s(now).length, 0);

  const contact = store.getContact(phoneNumber);
  assert.equal(contact.reminder2_scheduled_at, null);
  assert.equal(contact.reminder2_attempted_at, now.toISOString());
  assert.equal(contact.reminder2_sent_at, null);
});

test("a failed claimed downsell is not automatically due again", () => {
  const phoneNumber = "+543333333333";
  const now = new Date("2026-07-11T12:00:00.000Z");
  makeDownsellDue(phoneNumber);

  assert.equal(store.claimDueReminder2(phoneNumber, now), true);
  assert.equal(store.listDueReminder2s(new Date("2026-07-12T12:00:00.000Z")).length, 0);
});

test("initial offer includes home practice, professional use, and video confirmation", () => {
  const offer = store.getSetting("initial_offer_text");
  assert.match(offer, /práctica de yoga en casa/i);
  assert.match(offer, /profesor/i);
  assert.match(offer, /te comparto un video/i);
});

test("Instagram reminder text is split below the provider limit", () => {
  const text = `${"a".repeat(700)}\n\n${"b".repeat(700)}`;
  const chunks = reminderTextChunks(text, "instagram");

  assert.equal(chunks.length, 2);
  assert.ok(chunks.every((chunk) => Array.from(chunk).length <= INSTAGRAM_MESSAGE_LIMIT));
  assert.equal(chunks[0], "a".repeat(700));
  assert.equal(chunks[1], "b".repeat(700));
});

test("short reminder text remains a single message", () => {
  const text = "holaa, te mando por acá el detalle porque antes te mandé solo el video 🪴";
  assert.deepEqual(reminderTextChunks(text, "instagram"), [text]);
});

test("outside allowed window is treated as permanent reminder send failure", () => {
  const err = new Error("Zernio API error 403: This message is sent outside of allowed window.");
  assert.equal(isPermanentReminderSendError(err), true);
  assert.equal(isPermanentReminderSendError(new Error("network timeout")), false);
});

test("spanish allowed window policy error is permanent", () => {
  const err = new Error("Zernio API error 400: Este mensaje se envía fuera del período permitido.");
  assert.equal(isPermanentReminderSendError(err), true);
});
