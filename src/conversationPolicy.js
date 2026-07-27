import { reminderTextChunks } from "./reminderPolicy.js";

const INITIAL_OFFER_SECOND_MESSAGE = "En total recibís:";

export function initialOfferTextChunks(text, channel) {
  const value = String(text ?? "").trim();
  const markerIndex = value.indexOf(INITIAL_OFFER_SECOND_MESSAGE);

  if (markerIndex <= 0) return reminderTextChunks(value, channel);

  return [value.slice(0, markerIndex).trim(), value.slice(markerIndex).trim()]
    .flatMap((chunk) => reminderTextChunks(chunk, channel));
}

export function isMaterialPreviewConfirmation(text) {
  return /^(s[ií]+|si+|dale|ok|okay|okey|perfecto|claro|de una|bueno|mand[aá]lo|mand[aá]melo|mandame|m[aá]ndame|pasame|pas[aá]me|envi[aá]lo|envi[aá]melo|enviame|quiero verlo|quiero ver|me interesa|me sirve)(?:[!.,;:\s]+(dale|porfa|por favor|gracias|mand[aá]lo|mand[aá]melo|pasame|envi[aá]lo|envi[aá]melo|quiero verlo|quiero ver|me interesa))*[!.,;:\s]*$/i.test(
    String(text ?? "").trim()
  );
}

export function shouldAutoProcessPaymentAttachment(hasContext, proofDetails = {}) {
  return Boolean(hasContext && proofDetails.isPaymentProof);
}

export function hasCommercialPaymentContext(contact = {}, history = [], materialVideoSent = false) {
  if (contact.product_link_sent || contact.promo_sent || materialVideoSent) return true;

  return history.some(
    (item) =>
      item.role === "assistant" &&
      /kit\.yogapro|ofiprof\.mp|\$\s?4[\s.,]?999|4[\s.,]?999|comprobante|transfer|acceso|te libero|producto liberado/i.test(
        item.content ?? ""
      )
  );
}
