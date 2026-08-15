import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { hasCommercialPaymentContext, initialOfferTextChunks, shouldActivateExclusiveOffer, shouldAutoProcessPaymentAttachment } from "../src/conversationPolicy.js";
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

test("runtime sends the $9.999 offer after any reminder response and schedules the $6.999 final discount", () => {
  const awaiting = { paid: 0, reminder2_sent_at: "2026-08-12T10:00:00.000Z", exclusive_offer_accepted_at: null };
  for (const reply of ["OK", "dale", "lo voy a mirar", "cuánto queda?", "👍"]) {
    assert.equal(shouldActivateExclusiveOffer(awaiting, reply), true, `should activate for: ${reply}`);
  }
  assert.equal(shouldActivateExclusiveOffer(awaiting, "   "), false);
  assert.equal(shouldActivateExclusiveOffer({ ...awaiting, reminder2_sent_at: null }, "dale"), false);
  assert.equal(shouldActivateExclusiveOffer({ ...awaiting, exclusive_offer_accepted_at: "2026-08-12T11:00:00.000Z" }, "dale"), false);
  assert.equal(shouldActivateExclusiveOffer({ ...awaiting, paid: 1 }, "dale"), false);
  assert.match(indexSource, /shouldActivateExclusiveOffer\(contact, userMessage\)/);
  assert.match(indexSource, /acceptExclusiveOfferResponse\(phoneNumber\)/);
  assert.match(indexSource, /const finalAt = markExclusiveAliasSent\(phoneNumber\)/);
  assert.doesNotMatch(indexSource, /isExclusiveOfferOk/);
  assert.match(indexSource, /getSetting\("exclusive_offer_text"/);
  assert.match(indexSource, /markExclusiveOfferTextSent\(phoneNumber\)/);
  assert.match(indexSource, /markExclusiveAliasNoteSent\(phoneNumber\)/);
  assert.match(indexSource, /markExclusiveAliasSent\(phoneNumber\)/);
  assert.match(indexSource, /processDueFinalDiscounts/);
  assert.match(indexSource, /getSetting\("final_discount_text"/);
  assert.match(indexSource, /contact\.exclusive_alias_sent/);
  assert.match(indexSource, /contact\.final_discount_sent_at \? 6999 : contact\.exclusive_offer_text_sent \? 9999/);
});

test("runtime sends video, alias owner, alias, and payment instructions after any first reply", () => {
  assert.match(indexSource, /sendFantasiaVideo/);
  assert.match(indexSource, /markFantasiaVideoSent\(phoneNumber\)/);
  assert.match(indexSource, /!hasPaymentAliasBeenSent\(phoneNumber\)/);
  assert.match(indexSource, /getSetting\("payment_alias"/);
  assert.match(indexSource, /markPaymentAliasSent\(phoneNumber\)/);
  assert.match(indexSource, /getSetting\("payment_alias_note"/);
  assert.match(indexSource, /markPaymentAliasNoteSent\(phoneNumber\)/);
  assert.match(indexSource, /getSetting\("payment_instructions_text"/);
  assert.match(indexSource, /markPaymentInstructionsSent\(phoneNumber\)/);
  const videoIndex = indexSource.indexOf("await sendFantasiaVideo");
  const noteIndex = indexSource.indexOf('getSetting("payment_alias_note"', videoIndex);
  const aliasIndex = indexSource.indexOf('getSetting("payment_alias"', noteIndex);
  const instructionsIndex = indexSource.indexOf('getSetting("payment_instructions_text"', aliasIndex);
  assert.ok(videoIndex < noteIndex);
  assert.ok(noteIndex < aliasIndex);
  assert.ok(aliasIndex < instructionsIndex);
  assert.match(indexSource, /if \(!videoSent\) throw new Error/);
  assert.match(indexSource, /claimSecondResponseBatch\(phoneNumber\)/);
  assert.doesNotMatch(indexSource, /looksLikeVideoConfirmation|shouldSendFantasiaVideo|isMaterialPreviewConfirmation/);
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

test("a concurrent message waits for the claimed batch and retries it after failure", () => {
  const claimConflict = /if \(!claimSecondResponseBatch\(phoneNumber\)\) \{[\s\S]{0,420}?\n      \}/.exec(indexSource)?.[0] ?? "";
  assert.match(claimConflict, /already claimed/);
  assert.match(claimConflict, /await pendingBatch/);
  assert.match(claimConflict, /if \(!completed\) return processIncomingMessageImpl/);
});

test("an emoji-only response advances a pending second batch", () => {
  assert.match(indexSource, /isEmojiOnly\(userMessage\) && !secondBatchPending && !awaitingExclusiveOfferResponse && !exclusiveOfferPending/);
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
  assert.equal(hasCommercialPaymentContext({ exclusive_offer_text_sent: 1 }, [], false), true);
  assert.equal(hasCommercialPaymentContext({}, [{ role: "assistant", content: "Oferta exclusiva $9.999" }], false), true);
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
