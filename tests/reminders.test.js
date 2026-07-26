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

function makeReminderDue(phoneNumber, column = "reminder_scheduled_at") {
  store.ensureContact(phoneNumber, { conversationId: `conversation-${phoneNumber}` });
  db.prepare(`UPDATE contacts SET ${column} = ? WHERE phone_number = ?`).run(
    "2026-07-11T10:00:00.000Z",
    phoneNumber
  );
}

test("a due 6h reminder can be claimed only once", () => {
  const phoneNumber = "+541111111111";
  const now = new Date("2026-07-11T12:00:00.000Z");
  makeReminderDue(phoneNumber);

  assert.equal(store.listDueReminders(now).length, 1);
  assert.equal(store.claimDueReminder(phoneNumber, now), true);
  assert.equal(store.claimDueReminder(phoneNumber, now), false);
  assert.equal(store.listDueReminders(now).length, 0);

  const contact = store.getContact(phoneNumber);
  assert.equal(contact.reminder_scheduled_at, null);
  assert.equal(contact.reminder_attempted_at, now.toISOString());
  assert.equal(contact.reminder_sent_at, null);
});

test("a failed claimed reminder is not automatically due again", () => {
  const phoneNumber = "+542222222222";
  const now = new Date("2026-07-11T12:00:00.000Z");
  makeReminderDue(phoneNumber);

  assert.equal(store.claimDueReminder(phoneNumber, now), true);
  assert.equal(store.listDueReminders(new Date("2026-07-12T12:00:00.000Z")).length, 0);
});

test("claiming the 6h reminder does not consume the 23h reminder", () => {
  const phoneNumber = "+543333333333";
  const now = new Date("2026-07-11T12:00:00.000Z");
  makeReminderDue(phoneNumber);
  makeReminderDue(phoneNumber, "reminder2_scheduled_at");

  assert.equal(store.claimDueReminder(phoneNumber, now), true);
  assert.equal(store.listDueReminder2s(now).length, 1);
  assert.equal(store.claimDueReminder2(phoneNumber, now), true);
  assert.equal(store.claimDueReminder2(phoneNumber, now), false);
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
