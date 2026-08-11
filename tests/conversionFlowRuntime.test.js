import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { hasCommercialPaymentContext, initialOfferTextChunks, shouldAutoProcessPaymentAttachment } from "../src/conversationPolicy.js";
import { SOCIAL_MESSAGE_LIMIT } from "../src/reminderPolicy.js";

const indexSource = readFileSync(fileURLToPath(new URL("../src/index.js", import.meta.url)), "utf8");

test("runtime sends only the Fantasía greeting audio", () => {
  const audioKeys = [...indexSource.matchAll(/sendFlowAudio\([^;]+?"([a-zA-Z0-9]+)"/g)].map((match) => match[1]);
  assert.deepEqual(audioKeys, ["greeting"]);
  assert.match(indexSource, /voiceFile: "saludofantasia\.ogg"/);
});

test("runtime has no 6h reminder worker", () => {
  assert.doesNotMatch(indexSource, /processDueReminders|6h reminder|reminder_detail_text|reminder_product_description/);
});

test("runtime sends video, alias, and alias note on the first reply", () => {
  assert.match(indexSource, /sendFantasiaVideo/);
  assert.match(indexSource, /markFantasiaVideoSent\(phoneNumber\)/);
  assert.match(indexSource, /!hasPaymentAliasBeenSent\(phoneNumber\)/);
  assert.match(indexSource, /getSetting\("payment_alias"/);
  assert.match(indexSource, /markPaymentAliasSent\(phoneNumber\)/);
  assert.match(indexSource, /getSetting\("payment_alias_note"/);
  assert.match(indexSource, /markPaymentAliasNoteSent\(phoneNumber\)/);
  const videoIndex = indexSource.indexOf("await sendFantasiaVideo");
  const aliasIndex = indexSource.indexOf('getSetting("payment_alias"', videoIndex);
  const noteIndex = indexSource.indexOf('getSetting("payment_alias_note"', aliasIndex);
  assert.ok(videoIndex < aliasIndex);
  assert.ok(aliasIndex < noteIndex);
  assert.match(indexSource, /if \(!videoSent\) throw new Error/);
  assert.match(indexSource, /claimSecondResponseBatch\(phoneNumber\)/);
});

test("runtime retries the initial offer when the greeting voice note fails", () => {
  assert.match(indexSource, /if \(!greetingSent\) throw new Error/);
  assert.match(indexSource, /if \(initialOfferClaimed\) releaseInitialOfferClaim/);
});

test("runtime persists asynchronous greeting fallback and retries after fallback failure", () => {
  assert.match(indexSource, /return acceptedMessageId \? String\(acceptedMessageId\) : true/);
  assert.match(indexSource, /getGreetingAudioFallback\(failedMessageId\)/);
  assert.match(indexSource, /markGreetingAudioFailed\(fallback\.phoneNumber, failedMessageId\)/);
  assert.match(indexSource, /hasGreetingBeenSent\(phoneNumber\) && !hasGreetingAudioBeenSent\(phoneNumber\)/);
});

test("a concurrent message continues to the AI path when the second batch is already claimed", () => {
  const claimConflict = /if \(!claimSecondResponseBatch\(phoneNumber\)\) \{[\s\S]{0,180}?\}/.exec(indexSource)?.[0] ?? "";
  assert.match(claimConflict, /already claimed/);
  assert.doesNotMatch(claimConflict, /return/);
});

test("Fantasia media files are provider-safe", () => {
  const voicePath = fileURLToPath(new URL("../audios/saludofantasia.ogg", import.meta.url));
  const videoPath = fileURLToPath(new URL("../contenidofantasia-whatsapp.mp4", import.meta.url));
  assert.equal(readFileSync(voicePath).subarray(0, 4).toString(), "OggS");
  assert.ok(statSync(videoPath).size > 0);
  assert.ok(statSync(videoPath).size < 16 * 1024 * 1024);
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
