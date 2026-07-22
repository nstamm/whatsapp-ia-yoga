import test from "node:test";
import assert from "node:assert/strict";

function isDueReminder(contact, nowIso) {
  if (contact.paid || contact.handoff || contact.promo_sent) return false;
  if (contact.reminder_sent_at) return false;

  return (
    contact.reminder_scheduled_at && contact.reminder_scheduled_at <= nowIso
  );
}

function isDueReminder2(contact, nowIso) {
  if (contact.paid || contact.handoff || contact.promo_sent) return false;
  if (contact.reminder2_sent_at) return false;

  return (
    contact.reminder2_scheduled_at && contact.reminder2_scheduled_at <= nowIso
  );
}

function markReminderSentRow(contact, sentAt) {
  return {
    ...contact,
    reminder_sent_at: sentAt,
    reminder_scheduled_at: null,
  };
}

function markReminder2SentRow(contact, sentAt) {
  return {
    ...contact,
    reminder2_sent_at: sentAt,
    reminder2_scheduled_at: null,
  };
}

function isPermanentReminderSendError(err) {
  const message = String(err?.message ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  return (
    message.includes("outside of allowed window") ||
    message.includes("fuera del periodo permitido") ||
    message.includes("fuera de la ventana")
  );
}

test("sent reminder with stale second reminder is not due again", () => {
  const now = "2026-07-11T12:00:00.000Z";
  const contact = {
    paid: 0,
    handoff: 0,
    promo_sent: 0,
    reminder_sent_at: "2026-07-11T11:00:00.000Z",
    reminder_scheduled_at: null,
    reminder2_scheduled_at: "2026-07-11T10:00:00.000Z",
  };

  assert.equal(isDueReminder(contact, now), false);
  assert.equal(isDueReminder2(contact, now), true);
});

test("marking reminder sent clears only reminder_scheduled_at", () => {
  const sentAt = "2026-07-11T12:00:00.000Z";
  const contact = {
    reminder_scheduled_at: "2026-07-11T10:00:00.000Z",
    reminder2_scheduled_at: "2026-07-11T11:00:00.000Z",
  };

  assert.deepEqual(markReminderSentRow(contact, sentAt), {
    reminder_sent_at: sentAt,
    reminder_scheduled_at: null,
    reminder2_scheduled_at: "2026-07-11T11:00:00.000Z",
  });
});

test("marking reminder2 sent clears only reminder2_scheduled_at", () => {
  const sentAt = "2026-07-11T12:00:00.000Z";
  const contact = {
    reminder_scheduled_at: "2026-07-11T10:00:00.000Z",
    reminder2_scheduled_at: "2026-07-11T11:00:00.000Z",
  };

  assert.deepEqual(markReminder2SentRow(contact, sentAt), {
    reminder2_sent_at: sentAt,
    reminder_scheduled_at: "2026-07-11T10:00:00.000Z",
    reminder2_scheduled_at: null,
  });
});

test("second scheduled reminder is due only before it has been marked sent", () => {
  const now = "2026-07-11T12:00:00.000Z";
  const contact = {
    paid: 0,
    handoff: 0,
    promo_sent: 0,
    reminder_sent_at: null,
    reminder_scheduled_at: null,
    reminder2_scheduled_at: "2026-07-11T11:00:00.000Z",
  };

  assert.equal(isDueReminder2(contact, now), true);
  assert.equal(isDueReminder2(markReminder2SentRow(contact, now), now), false);
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
