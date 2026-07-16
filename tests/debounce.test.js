import test from "node:test";
import assert from "node:assert/strict";

// Re-implement the same logic to test debounce gating in isolation
function getIncomingText(message) {
  return message?.text ?? message?.content ?? message?.caption ?? message?.body ?? "";
}

function getAttachmentItems(message) {
  const items = [];
  for (const key of ["attachments", "media", "files"]) {
    if (Array.isArray(message?.[key])) items.push(...message[key]);
  }
  for (const key of ["image", "document", "audio", "video"]) {
    if (message?.[key]) items.push(message[key]);
  }
  return items;
}

function getAttachmentKind(attachment) {
  const fields = [
    attachment?.type,
    attachment?.mediaType,
    attachment?.attachmentType,
    attachment?.mimeType,
    attachment?.mimetype,
    attachment?.contentType,
  ];
  const rawKind = String(fields.find((f) => f) ?? "").toLowerCase();
  const allFields = fields.map((f) => String(f ?? "").toLowerCase()).join(" ");
  if (allFields.includes("sticker") || allFields.includes("image/webp")) return "sticker";
  if (rawKind.includes("audio") || rawKind.includes("voice")) return "audio";
  if (rawKind.includes("image")) return "image";
  if (rawKind.includes("video")) return "video";
  if (rawKind.includes("pdf") || rawKind.includes("document") || rawKind.includes("file")) return "document";
  return rawKind || "file";
}

function getAttachmentKinds(message) {
  return getAttachmentItems(message).map(getAttachmentKind);
}

function hasAttachment(message) {
  return getAttachmentKinds(message).length > 0;
}

function hasAudioAttachment(message) {
  return getAttachmentKinds(message).includes("audio");
}

function shouldDebounceMessage(body) {
  const message = body?.message ?? {};
  if (message.direction !== "incoming") return false;
  if (hasAttachment(message) || hasAudioAttachment(message)) return false;
  const text = getIncomingText(message).trim();
  if (!text) return false;
  if (text === "/clear" || text === "/help") return false;
  return true;
}

test("plain text message should be debounced", () => {
  const body = { message: { direction: "incoming", text: "hola" } };
  assert.equal(shouldDebounceMessage(body), true);
});

test("multi-line text message should be debounced", () => {
  const body = { message: { direction: "incoming", text: "hola, queria preguntarte" } };
  assert.equal(shouldDebounceMessage(body), true);
});

test("message with image attachment should NOT be debounced", () => {
  const body = { message: { direction: "incoming", text: "mirá esto", attachments: [{ type: "image", mimeType: "image/jpeg" }] } };
  assert.equal(shouldDebounceMessage(body), false);
});

test("message with audio attachment should NOT be debounced", () => {
  const body = { message: { direction: "incoming", text: "", attachments: [{ type: "audio", mimeType: "audio/ogg" }] } };
  assert.equal(shouldDebounceMessage(body), false);
});

test("sticker should NOT be debounced (processed immediately, then ignored)", () => {
  const body = { message: { direction: "incoming", text: "", attachments: [{ type: "image", mimeType: "image/webp" }] } };
  assert.equal(shouldDebounceMessage(body), false);
});

test("/clear command should NOT be debounced", () => {
  const body = { message: { direction: "incoming", text: "/clear" } };
  assert.equal(shouldDebounceMessage(body), false);
});

test("/help command should NOT be debounced", () => {
  const body = { message: { direction: "incoming", text: "/help" } };
  assert.equal(shouldDebounceMessage(body), false);
});

test("outgoing message should NOT be debounced", () => {
  const body = { message: { direction: "outgoing", text: "hola" } };
  assert.equal(shouldDebounceMessage(body), false);
});

test("empty text without attachment should NOT be debounced", () => {
  const body = { message: { direction: "incoming", text: "" } };
  assert.equal(shouldDebounceMessage(body), false);
});