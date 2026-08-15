import { reminderTextChunks } from "./reminderPolicy.js";

export function initialOfferTextChunks(text, channel) {
  return reminderTextChunks(String(text ?? "").trim(), channel);
}

export function shouldAutoProcessPaymentAttachment(hasContext, proofDetails = {}) {
  return Boolean(hasContext && proofDetails.isPaymentProof);
}

export function hasCommercialPaymentContext(contact = {}, history = [], paymentAliasSent = false) {
  if (contact.product_link_sent || contact.promo_sent || contact.exclusive_offer_text_sent || contact.final_discount_sent_at || paymentAliasSent) return true;

  return history.some(
    (item) =>
      item.role === "assistant" &&
      /pagos\.ofiprof|\$\s?(?:16[\s.,]?999|9[\s.,]?999|6[\s.,]?999)|comprobante|transfer|acceso|te libero|producto liberado/i.test(
        item.content ?? ""
      )
  );
}

export function shouldActivateExclusiveOffer(contact = {}, text = "") {
  return Boolean(
    !contact.paid &&
    contact.reminder2_sent_at &&
    !contact.exclusive_offer_accepted_at &&
    String(text ?? "").trim()
  );
}
