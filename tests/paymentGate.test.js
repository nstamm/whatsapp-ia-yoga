import test from "node:test";
import assert from "node:assert/strict";

// Re-implement the same logic to test the gating behavior in isolation
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

function getAttachmentKinds(message) {
  return getAttachmentItems(message).map(getAttachmentKind);
}

function hasPaymentAttachment(message) {
  return getAttachmentKinds(message).some((kind) => ["image", "document", "file"].includes(kind));
}

function hasPaymentProofText(text) {
  return /\b(comprobante|comprobante de pago|pague|pagué|ya pague|ya pagué|pago realizado|transferi|transferí|transferencia realizada|recibo|captura)\b/i.test(
    String(text ?? "")
  );
}

test("sticker with image/webp mimeType is classified as sticker, not image", () => {
  const sticker = { type: "image", mimeType: "image/webp" };
  assert.equal(getAttachmentKind(sticker), "sticker");
});

test("sticker with attachmentType sticker is classified as sticker", () => {
  const sticker = { attachmentType: "sticker" };
  assert.equal(getAttachmentKind(sticker), "sticker");
});

test("regular image with image/jpeg is classified as image", () => {
  const image = { type: "image", mimeType: "image/jpeg" };
  assert.equal(getAttachmentKind(image), "image");
});

test("sticker does not count as payment attachment", () => {
  const message = { attachments: [{ type: "image", mimeType: "image/webp" }] };
  assert.equal(hasPaymentAttachment(message), false);
});

test("regular image counts as payment attachment", () => {
  const message = { attachments: [{ type: "image", mimeType: "image/jpeg" }] };
  assert.equal(hasPaymentAttachment(message), true);
});

test("text saying comprobante alone does not trigger payment (no attachment)", () => {
  const message = {};
  const text = "ok ahi te mando comprobante";
  assert.equal(hasPaymentAttachment(message), false);
  // The webhook now requires isContextualPaymentAttachment, not isPaymentProofText
  // So text alone should NOT trigger the payment block
  assert.equal(hasPaymentProofText(text), true); // text matches, but...
  assert.equal(hasPaymentAttachment(message) && true, false); // ...no attachment, so no trigger
});

test("image with comprobante text triggers payment", () => {
  const message = { attachments: [{ type: "image", mimeType: "image/jpeg" }] };
  const text = "te paso el comprobante";
  assert.equal(hasPaymentAttachment(message), true);
  assert.equal(hasPaymentProofText(text), true);
  // Both conditions met → payment block triggers
  assert.equal(hasPaymentAttachment(message) && hasPaymentProofText(text), true);
});

test("sticker is detected in getAttachmentKinds", () => {
  const message = { attachments: [{ type: "image", mimeType: "image/webp" }] };
  const kinds = getAttachmentKinds(message);
  assert.equal(kinds.includes("sticker"), true);
});

test("non-payment image without text should be ignored (not sent to AI)", () => {
  const message = { attachments: [{ type: "image", mimeType: "image/jpeg" }] };
  const text = "";
  // hasPaymentAttachment is true, but no text → should be ignored
  assert.equal(hasPaymentAttachment(message), true);
  assert.equal(Boolean(text), false);
  // The webhook checks: hasPaymentAttachment(message) && !userMessage → return early
  assert.equal(hasPaymentAttachment(message) && !text, true);
});

test("image with text question should still go to AI", () => {
  const message = { attachments: [{ type: "image", mimeType: "image/jpeg" }] };
  const text = "es esto el kit?";
  // hasPaymentAttachment is true, but there IS text → should NOT be ignored
  assert.equal(hasPaymentAttachment(message), true);
  assert.equal(Boolean(text), true);
  // The webhook checks: hasPaymentAttachment(message) && !userMessage → does NOT return early
  assert.equal(hasPaymentAttachment(message) && !text, false);
});