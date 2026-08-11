import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { hasCommercialPaymentContext, initialOfferTextChunks, shouldAutoProcessPaymentAttachment } from "../src/conversationPolicy.js";
import { SOCIAL_MESSAGE_LIMIT } from "../src/reminderPolicy.js";

const indexSource = readFileSync(fileURLToPath(new URL("../src/index.js", import.meta.url)), "utf8");

test("runtime sends only the greeting audio", () => {
  const audioKeys = [...indexSource.matchAll(/sendFlowAudio\([^;]+?"([a-zA-Z0-9]+)"/g)].map((match) => match[1]);
  assert.deepEqual(audioKeys, ["greeting"]);
});

test("runtime has no 6h reminder worker", () => {
  assert.doesNotMatch(indexSource, /processDueReminders|6h reminder|reminder_detail_text|reminder_product_description/);
});

test("runtime sends the payment alias on the first reply and no video", () => {
  assert.doesNotMatch(indexSource, /sendMaterialVideo|shouldSendMaterialVideo|attachmentType:\s*["']video/);
  assert.match(indexSource, /!hasPaymentAliasBeenSent\(phoneNumber\)/);
  assert.match(indexSource, /getSetting\("payment_alias"/);
  assert.match(indexSource, /markPaymentAliasSent\(phoneNumber\)/);
});

test("runtime retries pending delivery for a paid contact", () => {
  assert.match(indexSource, /contact\.paid && !contact\.product_link_sent/);
  assert.match(indexSource, /Pending product access delivered/);
});

test("sending the alias creates payment context", () => {
  assert.equal(hasCommercialPaymentContext({}, [], false), false);
  assert.equal(hasCommercialPaymentContext({}, [], true), true);
  assert.equal(
    hasCommercialPaymentContext({}, [{ role: "assistant", content: "Transferí al alias pagos.ofiprof" }], false),
    true
  );
});

test("only a confirmed payment proof can be auto-processed", () => {
  assert.equal(shouldAutoProcessPaymentAttachment(true, { isPaymentProof: true }), true);
  assert.equal(shouldAutoProcessPaymentAttachment(true, { isPaymentProof: false }), false);
  assert.equal(shouldAutoProcessPaymentAttachment(false, { isPaymentProof: true }), false);
});

test("initial offer remains one message when it fits the provider limit", () => {
  const offer = "Fantasía Color PRO incluye libros, juegos y actividades imprimibles.";
  const chunks = initialOfferTextChunks(offer, "instagram");

  assert.deepEqual(chunks, [offer]);
  assert.ok(chunks.every((chunk) => Array.from(chunk).length <= SOCIAL_MESSAGE_LIMIT));
});

test("initial offer protects both Instagram and Facebook message limits", () => {
  const offer = `${"a".repeat(900)}\n\n${"b".repeat(1_200)}`;

  for (const channel of ["instagram", "facebook"]) {
    const chunks = initialOfferTextChunks(offer, channel);
    assert.equal(chunks[0], "a".repeat(900));
    assert.equal(chunks.slice(1).join(""), "b".repeat(1_200));
    assert.ok(chunks.every((chunk) => Array.from(chunk).length <= SOCIAL_MESSAGE_LIMIT));
  }
});
