import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { hasCommercialPaymentContext, initialOfferTextChunks, isMaterialPreviewConfirmation, shouldAutoProcessPaymentAttachment } from "../src/conversationPolicy.js";
import { SOCIAL_MESSAGE_LIMIT } from "../src/reminderPolicy.js";

const indexSource = readFileSync(fileURLToPath(new URL("../src/index.js", import.meta.url)), "utf8");

test("runtime sends only the greeting audio", () => {
  const audioKeys = [...indexSource.matchAll(/sendFlowAudio\([^;]+?"([a-zA-Z0-9]+)"/g)].map((match) => match[1]);
  assert.deepEqual(audioKeys, ["greeting"]);
});

test("runtime has no 6h reminder worker", () => {
  assert.doesNotMatch(indexSource, /processDueReminders|6h reminder|reminder_detail_text|reminder_product_description/);
});

test("runtime requires an affirmative reply before sending the material video", () => {
  assert.match(indexSource, /isMaterialPreviewConfirmation\(effectiveUserMessage\)/);
  for (const text of ["sí", "sí, por favor", "sí, quiero verlo", "sí, mandámelo", "dale, gracias", "mandámelo",
    "dale ok", "dale mandamelo ok", "sí perfecto", "mandámelo claro", "ok dale", "si bueno"]) {
    assert.equal(isMaterialPreviewConfirmation(text), true, `expected confirmation: ${text}`);
  }
  for (const text of ["no", "más adelante", "cuánto cuesta?"]) {
    assert.equal(isMaterialPreviewConfirmation(text), false, `unexpected confirmation: ${text}`);
  }
});

test("offering the video alone does not create payment context", () => {
  assert.equal(hasCommercialPaymentContext({ material_preview_offered: 1 }, [], false), false);
  assert.equal(hasCommercialPaymentContext({}, [], true), true);
  assert.equal(
    hasCommercialPaymentContext({}, [{ role: "assistant", content: "Transferí al alias kit.yogapro" }], false),
    true
  );
});

test("only a confirmed payment proof can be auto-processed", () => {
  assert.equal(shouldAutoProcessPaymentAttachment(true, { isPaymentProof: true }), true);
  assert.equal(shouldAutoProcessPaymentAttachment(true, { isPaymentProof: false }), false);
  assert.equal(shouldAutoProcessPaymentAttachment(false, { isPaymentProof: true }), false);
});

test("initial offer starts its second message at the total contents marker", () => {
  const offer = `Primera parte con la oferta.\n\nEn total recibís:\n\n9 PDFs + 6 videos`;
  const chunks = initialOfferTextChunks(offer, "instagram");

  assert.deepEqual(chunks, ["Primera parte con la oferta.", "En total recibís:\n\n9 PDFs + 6 videos"]);
  assert.ok(chunks.every((chunk) => Array.from(chunk).length <= SOCIAL_MESSAGE_LIMIT));
});

test("initial offer protects both Instagram and Facebook message limits", () => {
  const offer = `${"a".repeat(900)}\n\nEn total recibís:\n\n${"b".repeat(1_200)}`;

  for (const channel of ["instagram", "facebook"]) {
    const chunks = initialOfferTextChunks(offer, channel);
    assert.equal(chunks[0], "a".repeat(900));
    assert.equal(chunks[1].startsWith("En total recibís:"), true);
    assert.ok(chunks.every((chunk) => Array.from(chunk).length <= SOCIAL_MESSAGE_LIMIT));
  }
});
