import { config } from "dotenv";
config();
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import {
  extractNameCaptureWithAI,
  extractPaymentProofDetailsWithAI,
  getAIResponse,
  transcribeAudioFromUrl,
} from "./claude.js";
import { consumeInboxConversationPages, shouldProcessCtwaBackfillConversation, shouldRunCtwaBackfill } from "./ctwaBackfill.js";
import { BUSINESS_TIME_ZONE, businessDateKey as localDateKey, parseBusinessDateKey as parseDateKey, shiftBusinessDateKey as shiftDateKey } from "./businessDate.js";
import { buildConversationFlow, validateFlowSettings } from "./conversationFlow.js";
import { contactHistoryCsv } from "./contactExport.js";
import { hasCommercialPaymentContext, initialOfferTextChunks, shouldActivateExclusiveOffer, shouldAutoProcessPaymentAttachment } from "./conversationPolicy.js";
import { adminSectionDataNeeds, buildAdminConversationQuery, createAsyncTtlCache, isFreshTimestamp, isValidDateKey, mapWithConcurrency } from "./adminPerformance.js";
import { DEFAULT_META_AD_ACCOUNT_NAME, hasMetaAdsActivity, metaSpendInArs, primaryMetaAdAccountId, selectPrimaryMetaAdAccount, shouldReplaceLegacyMetaAdsMetrics } from "./metaAdsPolicy.js";
import { observeMetric, performanceSnapshot } from "./performanceMetrics.js";
import { isPermanentReminderSendError, reminderTextChunks } from "./reminderPolicy.js";
import {
  ensureWhatsAppDataset,
  getAdsTimeline,
  getMetaAdsTree,
  listInboxConversations,
  listMetaAdAccounts,
  listZernioAccounts,
  sendAdsConversion,
  sendTypingIndicator,
  sendWhatsAppConversion,
  sendWhatsAppMedia,
  sendWhatsAppMessage,
} from "./zernio.js";
import {
  getContact,
  resolveChannelContactId,
  getHistory,
  addMessage,
  clearHistory,
  claimInitialOffer,
  releaseInitialOfferClaim,
  hasGreetingBeenSent,
  markGreetingAudioSent,
  getGreetingAudioFallback,
  markGreetingAudioFailed,
  hasGreetingAudioBeenSent,
  markContactPaid,
  markProductLinkSent,
  requestHumanHandoff,
  isHumanHandoffRequested,
  resolveHumanHandoff,
  listHumanHandoffs,
  getAdminRevision,
  countConversationSummaries,
  listConversationSummaries,
  recordPayment,
  reverseLatestPayment,
  listPayments,
  listRecentPaidContactsMissingCtwaAttribution,
  listCtwaHourlyStats,
  listCtwaAttributedPayments,
  listCtwaCohortAttributedPayments,
  getSettings,
  updateSettings,
  getSetting,
  scheduleDownsell,
  listDueReminder2s,
  claimDueReminder2,
  markReminder2Sent,
  listDueFinalDiscounts,
  claimDueFinalDiscount,
  markFinalDiscountSent,
  acceptExclusiveOfferResponse,
  claimExclusiveOffer,
  releaseExclusiveOffer,
  markExclusiveOfferTextSent,
  markExclusiveAliasNoteSent,
  markExclusiveAliasSent,
  markManualOfferSent,
  saveContactCtwaAttribution,
  listCtwaAttributedConversations,
  saveContactName,
  hasNameBeenAsked,
  markNameAsked,
  getContactName,
  deleteContact,
  listContactHistoryForExport,
  purgeContactHistory,
  markPaymentAliasSent,
  hasPaymentAliasBeenSent,
  markPaymentAliasNoteSent,
  hasPaymentAliasNoteBeenSent,
  markPaymentInstructionsSent,
  hasPaymentInstructionsBeenSent,
  markFantasiaVideoSent,
  hasFantasiaVideoBeenSent,
  claimSecondResponseBatch,
  releaseSecondResponseBatch,
  getAdSpend,
  getMetaAdsDailyMetrics,
  deleteMetaAdsDailyMetrics,
  deleteUnassignedMetaAdsDailyMetrics,
  listAdSpendRange,
  listMetaAdsDailyMetricsRange,
  listUnassignedMetaAdsMetrics,
  upsertAdSpend,
  upsertMetaAdsDailyMetrics,
  getMetaConversionEvent,
  upsertMetaConversionEvent,
  getRevenueAdjustment,
  listRevenueAdjustmentsRange,
  upsertRevenueAdjustment,
} from "./store.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
const AUDIO_DIR = path.join(ROOT_DIR, "audios");
const FANTASIA_VIDEO_PATH = path.join(ROOT_DIR, "contenidofantasia-whatsapp.mp4");
const FLOW_AUDIOS = {
  greeting: { voiceFile: "saludofantasia.ogg", audioFile: "saludofantasia.mp3", label: "audio saludo Fantasía" },
};
const pendingAudioFallbacks = new Map();
const pendingSecondResponseBatches = new Map();

const app = express();
app.set("trust proxy", 1);
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use((req, res, next) => {
  const startedAt = performance.now();
  res.on("finish", () => {
    const route = String(req.route?.path ?? "/unmatched")
      .replace(/\/[0-9a-f]{16,}/gi, "/:id")
      .replace(/\/+\d{5,}/g, "/:id");
    const durationMs = performance.now() - startedAt;
    observeMetric(`http.${req.method}.${route}`, durationMs);
    if (durationMs >= 1000) console.warn(JSON.stringify({ event: "slow_http_request", method: req.method, route, durationMs: Math.round(durationMs), status: res.statusCode }));
  });
  next();
});
let cachedMetaAdsAccountId = "";
let cachedPrimaryAdAccountId = "";
let cachedPrimaryAdAccountCurrency = "";
let cachedPrimaryAdAccountName = "";
let latestAdsDashboard = null;
const metaAdsRefreshes = new Map();
let ctwaBackfillRequest = null;
let lastCtwaBackfillAt = 0;
const ctwaRecoveryTimers = new Map();
const adsDashboardCache = createAsyncTtlCache({
  ttlMs: Math.max(30_000, Number.parseInt(process.env.ADMIN_ADS_CACHE_TTL_MS ?? "300000", 10) || 300_000),
  maxEntries: 20,
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const MESSAGE_DEBOUNCE_MS = 20000;
const pendingMessages = new Map();
const activeContactOperations = new Set();
const deferredWebhookEvents = [];
let contactHistoryMaintenance = false;

function trackContactOperation(operation) {
  if (contactHistoryMaintenance) return Promise.resolve(false);
  const promise = Promise.resolve().then(operation);
  activeContactOperations.add(promise);
  promise.then(
    () => activeContactOperations.delete(promise),
    () => activeContactOperations.delete(promise)
  );
  return promise;
}

async function waitForContactOperations() {
  while (activeContactOperations.size) {
    await Promise.allSettled([...activeContactOperations]);
  }
}

function resumeDeferredWebhookEvents() {
  for (const entry of deferredWebhookEvents.splice(0)) {
    const event = entry.body?.event ?? entry.body?.type;
    const message = entry.body?.message;
    if (event === "conversation.started") {
      captureConversationStarted(entry.body);
    } else if (event === "message.received" && message?.direction === "incoming") {
      if (shouldDebounceMessage(entry.body)) {
        scheduleDebouncedMessage(entry);
      } else {
        processIncomingMessage(entry).catch((err) => {
          console.error("❌ Deferred incoming message failed:", err.message);
        });
      }
    }
  }
}

function clearContactRuntimeState() {
  for (const timer of ctwaRecoveryTimers.values()) clearTimeout(timer);
  ctwaRecoveryTimers.clear();
  for (const pending of pendingMessages.values()) clearTimeout(pending.timer);
  pendingMessages.clear();
  pendingAudioFallbacks.clear();
  pendingSecondResponseBatches.clear();
}

function getDebounceKey(identity) {
  return `${identity.channel}:${identity.contactId}`;
}

function getIncomingText(message) {
  return message?.text ?? message?.content ?? message?.caption ?? message?.body ?? "";
}

function firstValue(...values) {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return "";
}

function normalizeChannel(value) {
  const raw = String(value ?? "").toLowerCase();
  if (raw.includes("instagram")) return "instagram";
  if (raw.includes("facebook") || raw.includes("messenger")) return "facebook";
  if (raw.includes("whatsapp") || raw.includes("wa")) return "whatsapp";
  return "whatsapp";
}

function getWebhookIdentity(payload) {
  const message = payload?.message ?? {};
  const conversation = payload?.conversation ?? {};
  const account = payload?.account ?? {};
  const sender = message.sender ?? {};
  const contact = conversation.contact ?? {};
  const platform = normalizeChannel(
    firstValue(
      conversation.platform,
      account.platform,
      message.platform,
      conversation.inbox?.platform,
      conversation.inbox?.channel,
      account.type
    )
  );
  const accountId = firstValue(account.id, account.accountId, conversation.accountId, message.accountId);
  const conversationId = firstValue(message.conversationId, conversation.id);
  const phoneNumber = firstValue(sender.phoneNumber, message.from, contact.phoneNumber, conversation.participantPhoneNumber);

  if (platform !== "whatsapp" || (!phoneNumber && firstValue(conversation.participantId, sender.id, contact.id))) {
    const externalId = firstValue(conversation.participantId, sender.id, contact.id, sender.platformUserId, contact.platformUserId);
    const username = firstValue(sender.username, contact.username, contact.instagramUsername, conversation.participantUsername);
    const displayName = firstValue(conversation.participantName, sender.name, contact.name, username);
    const displayHandle = platform === "instagram" && username ? `@${username.replace(/^@+/, "")}` : displayName || username;
    return {
      contactId: resolveChannelContactId(platform, accountId, externalId || username || conversationId),
      channel: platform === "facebook" ? "facebook" : "instagram",
      accountId,
      conversationId,
      externalId,
      displayHandle,
      conversationUrl: firstValue(conversation.url, message.url),
      name: displayName,
    };
  }

  return {
    contactId: phoneNumber,
    channel: "whatsapp",
    accountId,
    conversationId,
    externalId: phoneNumber,
    displayHandle: phoneNumber,
    conversationUrl: firstValue(conversation.url, message.url),
    name: firstValue(contact.name, sender.name, conversation.participantName),
  };
}

function extractCtwaAttribution(payload = {}) {
  const message = payload.message ?? {};
  const conversation = payload.conversation ?? {};
  const candidates = [
    conversation.metadata,
    message.metadata,
    message.referral,
    message.referral?.metadata,
    payload.referral,
    payload.metadata,
  ].filter(Boolean);

  for (const meta of candidates) {
    const sourceId = firstValue(meta.ctwa_source_id, meta.meta_ad_id, meta.source_id, meta.ad_id, meta.adId, meta.platformAdId);
    const clid = firstValue(meta.ctwa_clid, meta.clid);
    if (!sourceId && !clid) continue;

    return {
      ctwaClid: clid,
      ctwaSourceId: sourceId,
      ctwaSourceUrl: firstValue(meta.ctwa_source_url, meta.meta_ad_video_url, meta.source_url, meta.url),
      ctwaHeadline: firstValue(meta.ctwa_headline, meta.meta_ad_title, meta.headline, meta.title),
      ctwaSourceType: firstValue(meta.ctwa_source_type, meta.meta_ad_type, meta.meta_ad_source, meta.source_type, meta.type),
      ctwaCapturedAt: firstValue(meta.ctwa_captured_at, meta.meta_ad_captured_at, meta.captured_at, new Date().toISOString()),
      rawJson: meta,
    };
  }

  return null;
}

function hoursSince(value) {
  if (!value) return Number.POSITIVE_INFINITY;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return Number.POSITIVE_INFINITY;
  return (Date.now() - date.getTime()) / (60 * 60 * 1000);
}

function zernioOptionsFor(contactOrIdentity = {}, options = {}) {
  const channel = contactOrIdentity.channel;
  const sendOptions = { accountId: contactOrIdentity.accountId ?? contactOrIdentity.account_id ?? "" };
  const lastIncomingAt = contactOrIdentity.lastIncomingAt ?? contactOrIdentity.last_incoming_at;

  if (options.allowHumanAgentTag && ["instagram", "facebook"].includes(channel) && hoursSince(lastIncomingAt) >= 23) {
    sendOptions.messagingType = "MESSAGE_TAG";
    sendOptions.messageTag = "HUMAN_AGENT";
  }

  return sendOptions;
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
  if (rawKind.includes("pdf") || rawKind.includes("document") || rawKind.includes("file")) {
    return "document";
  }

  return rawKind || "file";
}

function getAttachmentUrl(attachment) {
  if (typeof attachment === "string") return attachment;

  return (
    attachment?.url ??
    attachment?.downloadUrl ??
    attachment?.mediaUrl ??
    attachment?.fileUrl ??
    attachment?.attachmentUrl ??
    attachment?.link ??
    attachment?.href ??
    attachment?.sourceUrl ??
    attachment?.payload?.url ??
    attachment?.payload?.downloadUrl ??
    ""
  );
}

function getAttachmentItems(message) {
  const items = [];

  for (const key of ["attachments", "media", "files"]) {
    if (Array.isArray(message?.[key])) {
      items.push(...message[key]);
    }
  }

  for (const key of ["image", "document", "audio", "video"]) {
    if (message?.[key]) items.push(message[key]);
  }

  return items;
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

function getAudioAttachmentUrl(message) {
  const audioAttachment = getAttachmentItems(message).find((attachment) => getAttachmentKind(attachment) === "audio");
  return getAttachmentUrl(audioAttachment);
}

function hasPaymentAttachment(message) {
  return getAttachmentKinds(message).some((kind) => ["image", "document", "file"].includes(kind));
}

function getPaymentImageAttachmentUrl(message) {
  const imageAttachment = getAttachmentItems(message).find((attachment) => getAttachmentKind(attachment) === "image");
  return getAttachmentUrl(imageAttachment);
}

function hasPaymentProofText(text) {
  return /\b(comprobante|comprobante de pago|pague|pagué|ya pague|ya pagué|pago realizado|transferi|transferí|transferencia realizada|recibo|captura)\b/i.test(
    String(text ?? "")
  );
}

function looksLikePaymentProof(text, message) {
  return hasPaymentAttachment(message) || hasPaymentProofText(text);
}

function humanDelayFor(text) {
  const base = 1200;
  const perChar = Math.min(text.length * 18, 2600);
  const jitter = Math.floor(Math.random() * 1400);
  return base + perChar + jitter;
}

function publicBaseUrl(req) {
  const configuredBaseUrl = process.env.PUBLIC_BASE_URL || process.env.PUBLIC_BASE_KEY;
  if (configuredBaseUrl) return configuredBaseUrl.replace(/\/$/, "");

  const forwardedHost = req.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwardedHost || req.get("host");
  const forwardedProto = req.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const protocol = forwardedProto ?? req.protocol;

  return `${protocol}://${host}`;
}

function publicBaseUrlForWorker() {
  const configuredBaseUrl = process.env.PUBLIC_BASE_URL || process.env.PUBLIC_BASE_KEY;
  return configuredBaseUrl ? configuredBaseUrl.replace(/\/$/, "") : "";
}

function publicAudioUrl(req, audioKey, variant = "audio") {
  const audio = FLOW_AUDIOS[audioKey];
  if (!audio) return "";

  const file = variant === "voice" ? audio.voiceFile : audio.audioFile;
  const baseUrl = req ? publicBaseUrl(req) : publicBaseUrlForWorker();
  return baseUrl && file ? `${baseUrl}/media/audios/${file}` : "";
}

function prunePendingAudioFallbacks() {
  const expiresBefore = Date.now() - 30 * 60 * 1000;
  for (const [messageId, fallback] of pendingAudioFallbacks.entries()) {
    if ((fallback?.createdAt ?? 0) < expiresBefore) pendingAudioFallbacks.delete(messageId);
  }
}

function isPublicHttpsUrl(value) {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();

    return (
      url.protocol === "https:" &&
      hostname !== "localhost" &&
      hostname !== "127.0.0.1" &&
      hostname !== "::1"
    );
  } catch {
    return false;
  }
}

async function checkPublicMediaUrl(url, expectedType = "audio/") {
  try {
    const res = await fetch(url, { method: "GET" });
    const contentType = res.headers.get("content-type") ?? "";

    if (!res.ok) {
      return { ok: false, status: res.status, contentType, reason: `HTTP ${res.status}` };
    }

    if (!contentType.toLowerCase().startsWith(expectedType)) {
      return { ok: false, status: res.status, contentType, reason: `Content-Type ${contentType || "missing"}` };
    }

    return { ok: true, status: res.status, contentType };
  } catch (err) {
    return { ok: false, status: 0, contentType: "", reason: err.message };
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function isLocalAdminRequest(req) {
  const address = String(req.socket?.remoteAddress ?? "").replace(/^::ffff:/, "");
  return address === "127.0.0.1" || address === "::1";
}

function getAdminToken(req) {
  return req.get("x-admin-token") ?? req.query.token ?? req.body?.token ?? "";
}

function isAdminAuthorized(req) {
  if (process.env.ADMIN_TOKEN) return getAdminToken(req) === process.env.ADMIN_TOKEN;
  return process.env.NODE_ENV !== "production" && isLocalAdminRequest(req);
}

function adminPath(req, options = {}) {
  const params = new URLSearchParams();
  const token = getAdminToken(req);
  const section = options.section ?? req.body?.section ?? req.query.section;

  if (token) params.set("token", token);
  if (options.status) params.set("status", options.status);
  if (section) params.set("section", section);
  if (options.from) params.set("from", options.from);
  if (options.to) params.set("to", options.to);
  if (options.date) params.set("date", options.date);
  if (options.ctwaPages != null) params.set("ctwaPages", options.ctwaPages);
  if (options.ctwaConversations != null) params.set("ctwaConversations", options.ctwaConversations);
  if (options.ctwaAttributed != null) params.set("ctwaAttributed", options.ctwaAttributed);
  if (options.ctwaErrors != null) params.set("ctwaErrors", options.ctwaErrors);
  if (options.convFilter) params.set("convFilter", options.convFilter);
  if (req.query.convFilter && !options.convFilter) params.set("convFilter", req.query.convFilter);

  const query = params.toString();
  return `/admin${query ? `?${query}` : ""}${options.anchor ? `#${options.anchor}` : ""}`;
}

function requireAdmin(req, res, next) {
  if (isAdminAuthorized(req)) return next();

  res.status(401).send(`<!doctype html>
<html lang="es">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ofiprof Admin</title></head>
<body style="font-family:Arial,sans-serif;background:#f6f2ea;color:#201b16;padding:40px">
  <main style="max-width:560px;margin:auto;background:#fff;border:1px solid #e6ddcf;border-radius:24px;padding:32px">
    <p style="letter-spacing:.16em;text-transform:uppercase;font-size:12px;color:#8a735d">Acceso protegido</p>
    <h1 style="margin:0 0 12px;font-size:28px">Panel no disponible</h1>
    <p>Para abrirlo desde la URL publica de ngrok, agregá <code>ADMIN_TOKEN</code> en tu <code>.env</code> y entrá con <code>/admin?token=TU_TOKEN</code>.</p>
    <p>Sin token, solo se permite desde <code>http://localhost:3000/admin</code>.</p>
  </main>
</body>
  </html>`);
}

function requireSensitiveAdmin(req, res, next) {
  if (!process.env.ADMIN_TOKEN) {
    return res.status(503).send("ADMIN_TOKEN is required for contact export and deletion.");
  }
  if (getAdminToken(req) !== process.env.ADMIN_TOKEN) return res.status(401).send("Unauthorized");
  return next();
}

async function sendGreetingAudio(req, conversationId, phoneNumber, isLocalTest, options = {}) {
  if (hasGreetingAudioBeenSent(phoneNumber)) return true;

  const sent = await sendFlowAudio(req, conversationId, phoneNumber, "greeting", isLocalTest, options);
  if (sent) {
    addMessage(phoneNumber, "assistant", "[audio saludo]", { conversationId });
    markGreetingAudioSent(phoneNumber, typeof sent === "string" ? sent : "");
  }
  return sent;
}

async function sendFantasiaVideo(req, conversationId, phoneNumber, isLocalTest, options = {}) {
  const videoUrl = `${publicBaseUrl(req)}/media/contenidofantasia.mp4`;
  if (isLocalTest) {
    console.log(`🧪 Local test Fantasía video: ${videoUrl}`);
    return true;
  }
  if (!isPublicHttpsUrl(videoUrl)) {
    console.warn(`⚠️ Fantasía video skipped. URL must be public HTTPS: ${videoUrl}`);
    return false;
  }

  try {
    try {
      await sendTypingIndicator(conversationId, zernioOptionsFor(options));
      await sleep(900);
    } catch (typingErr) {
      console.warn(`⚠️ Typing indicator failed before Fantasía video for ${phoneNumber}:`, typingErr.message);
    }
    await sendWhatsAppMedia(conversationId, videoUrl, "video", zernioOptionsFor(options));
    console.log(`🎬 Fantasía video sent to ${phoneNumber}`);
    return true;
  } catch (err) {
    console.warn(`⚠️ Fantasía video failed for ${phoneNumber}:`, err.message);
    return false;
  }
}

async function sendFlowAudio(req, conversationId, phoneNumber, audioKey, isLocalTest, options = {}) {
  const audio = FLOW_AUDIOS[audioKey];

  if (!audio) return false;

  const shouldTryVoiceNote = options.channel !== "instagram";
  const audioUrl = publicAudioUrl(req, audioKey, shouldTryVoiceNote ? "voice" : "audio");

  if (isLocalTest) {
    console.log(`🧪 Local test ${audio.label}: ${audioUrl || "missing public base URL"}`);
    return true;
  }

  if (!isPublicHttpsUrl(audioUrl)) {
    console.warn(`⚠️ ${audio.label} skipped. URL must be public HTTPS: ${audioUrl || "missing PUBLIC_BASE_URL/PUBLIC_BASE_KEY"}`);
    return false;
  }

  try {
    const baseOptions = zernioOptionsFor(options);
    const mode = shouldTryVoiceNote ? "voiceNote" : "audio";
    const mediaCheck = await checkPublicMediaUrl(audioUrl, "audio/");

    if (!mediaCheck.ok) {
      console.warn(
        `⚠️ ${audio.label} public URL check failed for ${phoneNumber}: ${mediaCheck.reason}. URL=${audioUrl}`
      );
      return false;
    }

    console.log(
      `🎙️ Sending ${audio.label} to ${phoneNumber} as ${mode}: ${audioUrl} (${mediaCheck.contentType})`
    );

    let result;

    try {
      result = await sendWhatsAppMedia(conversationId, audioUrl, "audio", {
        ...baseOptions,
        voiceNote: shouldTryVoiceNote,
      });
    } catch (err) {
      if (!shouldTryVoiceNote) throw err;

      console.warn(`⚠️ ${audio.label} voice note rejected for ${phoneNumber}: ${err.message}`);
      return sendFlowAudioFallback(req, conversationId, phoneNumber, audioKey, isLocalTest, options, "voice note rejected");
    }

    const acceptedMessageId = result?.data?.messageId ?? result?.messageId;
    console.log(
      `🎙️ ${audio.label} accepted by Zernio for ${phoneNumber}: ${JSON.stringify({
        messageId: acceptedMessageId,
        conversationId: result?.data?.conversationId ?? result?.conversationId,
        sentAt: result?.data?.sentAt ?? result?.sentAt,
      })}`
    );

    if (shouldTryVoiceNote && acceptedMessageId) {
      prunePendingAudioFallbacks();
      pendingAudioFallbacks.set(String(acceptedMessageId), {
        req,
        conversationId,
        phoneNumber,
        audioKey,
        options,
        createdAt: Date.now(),
      });
    }

    return acceptedMessageId ? String(acceptedMessageId) : true;
  } catch (err) {
    console.warn(`⚠️ ${audio.label} failed for ${phoneNumber}:`, err.message);
    return false;
  }
}

async function sendFlowAudioFallback(req, conversationId, phoneNumber, audioKey, isLocalTest, options = {}, reason = "fallback") {
  const audio = FLOW_AUDIOS[audioKey];
  const audioUrl = publicAudioUrl(req, audioKey, "audio");

  if (!audio) return false;

  if (isLocalTest) {
    console.log(`🧪 Local test fallback ${audio.label}: ${audioUrl || "missing public base URL"}`);
    return true;
  }

  if (!isPublicHttpsUrl(audioUrl)) {
    console.warn(`⚠️ ${audio.label} fallback skipped. URL must be public HTTPS: ${audioUrl || "missing PUBLIC_BASE_URL/PUBLIC_BASE_KEY"}`);
    return false;
  }

  const mediaCheck = await checkPublicMediaUrl(audioUrl, "audio/");
  if (!mediaCheck.ok) {
    console.warn(`⚠️ ${audio.label} fallback URL check failed for ${phoneNumber}: ${mediaCheck.reason}. URL=${audioUrl}`);
    return false;
  }

  const result = await sendWhatsAppMedia(conversationId, audioUrl, "audio", zernioOptionsFor(options));
  console.log(
    `🎙️ ${audio.label} fallback MP3 accepted by Zernio for ${phoneNumber} (${reason}): ${JSON.stringify({
      messageId: result?.data?.messageId ?? result?.messageId,
      conversationId: result?.data?.conversationId ?? result?.conversationId,
      sentAt: result?.data?.sentAt ?? result?.sentAt,
    })}`
  );
  return true;
}

async function askNameIfNeeded(conversationId, phoneNumber, isLocalTest, options = {}) {
  if (hasNameBeenAsked(phoneNumber)) return;
  if (getContactName(phoneNumber)) return;

  const askNameText = getSetting("ask_name_text", "Cómo te llamás?");

  if (isLocalTest) {
    console.log(`🧪 Local test ask name text: ${askNameText}`);
    markNameAsked(phoneNumber);
    return;
  }

  await sendWhatsAppMessage(conversationId, askNameText, zernioOptionsFor(options));
  markNameAsked(phoneNumber);
}

const NAME_REMAINDER_PATTERN =
  /\s*(?:[,.;-]|\by\b|\btambien\b|\btambién\b|\bademas\b|\bademás\b|\bquiero\b|\bqueria\b|\bquería\b|\bquisiera\b|\bnecesito\b|\bconsulta\b|\bconsulto\b|\bpregunto\b|\bme interesa\b|\bme pasas\b|\bme pasás\b|\bpasame\b|\bpasáme\b|\bpasar?\b|\bpasá\b|\bmanda\b|\bmandá\b|\bmandame\b|\bmándame\b|\bcontame\b|\bcuentame\b|\bcuéntame\b|\bcuanto\b|\bcuánto\b|\bprecio\b|\bvalor\b|\binfo\b|\binformaci[oó]n\b|\bproducto\b|\bkit\b|\bcompr\w*\b|\bpago\b)\s+/i;
const NAME_INTENT_PATTERN =
  /\b(quiero|queria|quería|quisiera|necesito|consulta|consulto|pregunto|me interesa|me pasas|me pasás|pasame|pasáme|pasar?|pasá|manda|mandá|mandame|mándame|contame|cuentame|cuéntame|cuanto|cuánto|precio|valor|info|informaci[oó]n|producto|kit|compr\w*|pago)\b/i;

function splitNameRemainder(text) {
  const value = String(text ?? "").trim().replace(/\s+/g, " ");
  const separator = value.match(NAME_REMAINDER_PATTERN);

  if (!separator) return { nameText: value, remainingText: "" };

  const separatorText = separator[0].trim();
  const shouldKeepSeparator = !/^(,|\.|;|-|y|tambien|también|ademas|además)$/i.test(separatorText);
  const remainingText = value.slice(separator.index + separator[0].length).trim();

  return {
    nameText: value.slice(0, separator.index).trim(),
    remainingText: shouldKeepSeparator ? `${separatorText} ${remainingText}`.trim() : remainingText,
  };
}

function cleanLikelyName(text) {
  const value = String(text ?? "").trim().replace(/\s+/g, " ");

  if (value.length < 2 || value.length > 50) return "";
  if (value.split(" ").length > 4) return "";
  if (/https?:|www\.|@|\$|\d{3,}|[¿?¡!]/i.test(value)) return "";
  if (/precio|valor|cuanto|cuánto|producto|fantas[ií]a|coloreable|compr|pago|alias|ofiprof|comprobante|transfer|info|pasame|pasáme|mandame|mándame|contame/i.test(value)) return "";
  if (!/^[a-záéíóúüñ' -]+$/i.test(value)) return "";

  return value
    .split(" ")
    .map((part) => (part ? `${part[0].toUpperCase()}${part.slice(1).toLowerCase()}` : part))
    .join(" ");
}

function extractNameCapture(text) {
  const value = String(text ?? "").trim().replace(/\s+/g, " ");

  if (!value) return { name: "", remainingText: "" };

  const leadingMatch = value.match(/^(?:me llamo|mi nombre es|soy|yo soy)\s+(.+)$/i);

  if (leadingMatch) {
    const { nameText, remainingText } = splitNameRemainder(leadingMatch[1]);
    return { name: cleanLikelyName(nameText), remainingText };
  }

  const reverseMatch = value.match(
    /^(.+?)\s+me llamo(?:\s*((?:[,.;-]|\by\b|\btambien\b|\btambién\b|\bademas\b|\bademás\b|\bquiero\b|\bqueria\b|\bquería\b|\bquisiera\b|\bnecesito\b|\bconsulta\b|\bconsulto\b|\bpregunto\b|\bme interesa\b|\bme pasas\b|\bme pasás\b|\bpasame\b|\bpasáme\b|\bpasar?\b|\bpasá\b|\bmanda\b|\bmandá\b|\bmandame\b|\bmándame\b|\bcontame\b|\bcuentame\b|\bcuéntame\b|\bcuanto\b|\bcuánto\b|\bprecio\b|\bvalor\b|\binfo\b|\binformaci[oó]n\b|\bproducto\b|\bkit\b|\bcompr\w*\b|\bpago\b))\s*(.*))?$/i
  );

  if (reverseMatch) {
    const separatorText = String(reverseMatch[2] ?? "").trim();
    const remainingText = String(reverseMatch[3] ?? "").trim();
    const shouldKeepSeparator = separatorText && !/^(,|\.|;|-|y|tambien|también|ademas|además)$/i.test(separatorText);

    return {
      name: cleanLikelyName(reverseMatch[1]),
      remainingText: shouldKeepSeparator ? `${separatorText} ${remainingText}`.trim() : remainingText,
    };
  }

  const fallback = splitNameRemainder(value);
  const fallbackName = cleanLikelyName(fallback.nameText);

  return { name: fallbackName, remainingText: fallbackName ? fallback.remainingText : "" };
}

function shouldUseAINameFallback(text, nameCapture) {
  const value = String(text ?? "").trim().replace(/\s+/g, " ");

  if (!value) return false;
  if (!nameCapture.name) return true;
  if (!nameCapture.remainingText && value.split(" ").length > 1 && NAME_INTENT_PATTERN.test(value)) return true;
  if (!nameCapture.remainingText && nameCapture.name.split(" ").length > 2) return true;

  return false;
}

async function extractNameCaptureSafely(text) {
  const localCapture = extractNameCapture(text);

  if (!shouldUseAINameFallback(text, localCapture)) return localCapture;

  try {
    const aiCapture = await extractNameCaptureWithAI(text);
    if (aiCapture.name) return aiCapture;
  } catch (err) {
    console.warn("⚠️ AI name extraction failed:", err.message);
  }

  return localCapture;
}

function extractLikelyName(text) {
  return extractNameCapture(text).name;
}

const EMOJI_ONLY_RE = /^(?:\s*(?:\p{Emoji_Presentation}|\p{Emoji}\uFE0F|\p{Emoji_Modifier_Base}\p{Emoji_Modifier}?|\p{Emoji_Component}|\s\u200d)+\s*)+$/u;

function isEmojiOnly(text) {
  return EMOJI_ONLY_RE.test(String(text ?? "").trim());
}

function looksLikePriceInquiry(text) {
  return /precio|valor|cu[aá]nto|cuanto|sale|cuesta|compr|pago|pag[ao]|alias|transfer|mercado ?pago|mp|prom[oó]|descuento/i.test(
    String(text ?? "")
  );
}

async function sendReminderText(contact, text, options, label) {
  const chunks = reminderTextChunks(text, contact.channel);

  for (const [index, chunk] of chunks.entries()) {
    try {
      await sendTypingIndicator(contact.conversation_id, options);
    } catch (typingErr) {
      console.warn(`⚠️ Typing indicator failed before ${label} for ${contact.phone_number}:`, typingErr.message);
    }

    await sleep(humanDelayFor(chunk));
    await sendWhatsAppMessage(contact.conversation_id, chunk, options);
    addMessage(contact.phone_number, "assistant", chunk, { conversationId: contact.conversation_id });

    if (chunks.length > 1) {
      console.log(`📄 ${label} part ${index + 1}/${chunks.length} sent to ${contact.phone_number}`);
    }
  }
}

async function processDueDownsellsImpl() {
  const due = listDueReminder2s();

  for (const contact of due) {
    // Use the same at-most-once policy for the second automated offer.
    if (!claimDueReminder2(contact.phone_number)) continue;

    const freshContact = getContact(contact.phone_number);
    if (freshContact.paid || freshContact.handoff || freshContact.promo_sent) {
      continue;
    }

    if (!contact.conversation_id) {
      console.warn(`⚠️ 23h reminder skipped for ${contact.phone_number}: missing conversationId`);
      continue;
    }

    try {
      const text = getSetting("reminder2_offer_text", "").trim();
      if (!text) continue;

      const options = zernioOptionsFor(contact);
      await sendReminderText(contact, text, options, "23h reminder");
      markReminder2Sent(contact.phone_number);
      console.log(`📣 23h reminder sent to ${contact.phone_number}`);
    } catch (err) {
      if (isPermanentReminderSendError(err)) {
        markReminder2Sent(contact.phone_number);
        console.warn(`⏭️ 23h reminder stopped for ${contact.phone_number}: ${err.message}`);
        continue;
      }

      console.error(`❌ Error sending 23h reminder to ${contact.phone_number}; automatic retry disabled:`, err.message);
    }
  }
}

function processDueDownsells() {
  return trackContactOperation(processDueDownsellsImpl);
}

async function processDueFinalDiscountsImpl() {
  const due = listDueFinalDiscounts();
  for (const contact of due) {
    if (!claimDueFinalDiscount(contact.phone_number)) continue;
    const freshContact = getContact(contact.phone_number);
    if (freshContact.paid || freshContact.handoff) continue;
    if (!contact.conversation_id) {
      console.warn(`⚠️ Final discount skipped for ${contact.phone_number}: missing conversationId`);
      continue;
    }
    try {
      const text = getSetting("final_discount_text", "").trim();
      if (!text) continue;
      await sendReminderText(contact, text, zernioOptionsFor(contact), "final discount");
      markFinalDiscountSent(contact.phone_number);
      console.log(`📣 Final $6.999 discount sent to ${contact.phone_number}`);
    } catch (err) {
      if (isPermanentReminderSendError(err)) {
        markFinalDiscountSent(contact.phone_number);
        console.warn(`⏭️ Final discount stopped for ${contact.phone_number}: ${err.message}`);
        continue;
      }
      console.error(`❌ Error sending final discount to ${contact.phone_number}; automatic retry disabled:`, err.message);
    }
  }
}

function processDueFinalDiscounts() {
  return trackContactOperation(processDueFinalDiscountsImpl);
}

function buildProductDeliveryText() {
  const productAccessUrl = getSetting("product_access_url");
  return getSetting("product_delivery_text").replaceAll("{{product_access_url}}", productAccessUrl);
}

function buildProductLandingText() {
  const landingUrl = getSetting("product_landing_url");
  return getSetting("product_landing_text").replaceAll("{{product_landing_url}}", landingUrl);
}

function buildPaidProofDeliveryText(wasAccessAlreadySent) {
  const productAccessUrl = getSetting("product_access_url");

  if (wasAccessAlreadySent) {
    return `perfecto, ya quedó registrado el pago 🙌

Te dejo de nuevo el acceso completo por las dudas:
${productAccessUrl}`;
  }

  return buildProductDeliveryText();
}

function buildManualOfferText(settingKey) {
  const productAccessUrl = getSetting("product_access_url");
  return getSetting(settingKey).replaceAll("{{product_access_url}}", productAccessUrl);
}

async function extractAndSavePaymentName(phoneNumber, userMessage, imageUrl) {
  const existingName = getContactName(phoneNumber);
  const result = { name: "", amount: 0, isPaymentProof: false };

  if (!existingName && userMessage.trim()) {
    try {
      result.name = (await extractNameCaptureSafely(userMessage)).name;
    } catch (err) {
      console.warn(`⚠️ Payment text name extraction failed for ${phoneNumber}:`, err.message);
    }
  }

  if (imageUrl) {
    try {
      const details = await extractPaymentProofDetailsWithAI({ userText: userMessage, imageUrl });
      if (!existingName) result.name ||= details.payerName;
      result.amount = details.amount;
      result.isPaymentProof = details.isPaymentProof;
    } catch (err) {
      console.warn(`⚠️ Payment image name extraction failed for ${phoneNumber}:`, err.message);
    }
  }

  if (result.name) {
    saveContactName(phoneNumber, result.name);
    console.log(`📝 Payment name saved for ${phoneNumber}: ${result.name}`);
  }

  return result;
}

const PAYMENT_PRODUCTS = {
  fantasia: {
    code: "fantasia-color-pro",
    name: "Fantasía Color PRO",
    shortName: "WhatsApp",
    amount: 16999,
    discount: 0,
  },
};

const ADMIN_SECTIONS = new Set(["dashboard", "ads", "conversations", "income", "flow", "settings"]);
const MONEY_FORMATTER = new Intl.NumberFormat("es-AR", {
  style: "currency",
  currency: "ARS",
  maximumFractionDigits: 0,
});

function parseMoney(value, fallback = 0) {
  const parsed = Number.parseInt(String(value ?? "").replace(/[^0-9-]/g, ""), 10);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : fallback;
}

function parseSignedMoney(value, fallback = 0) {
  const parsed = Number.parseInt(String(value ?? "").replace(/[^0-9-]/g, ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function formatMoney(value) {
  return MONEY_FORMATTER.format(value);
}

function formatSignedMoney(value) {
  const amount = Number(value) || 0;
  if (amount === 0) return formatMoney(0);
  return `${amount > 0 ? "+" : "-"}${formatMoney(Math.abs(amount))}`;
}

function formatMoneyShort(value) {
  return MONEY_FORMATTER.format(value).replace(/^[\$\s]+/, "");
}

function formatDateTime(value) {
  if (!value) return "-";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";

  return date.toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short", timeZone: BUSINESS_TIME_ZONE });
}

function isFutureDateKey(dateKey, todayKey = localDateKey()) {
  return String(dateKey ?? "") > todayKey;
}

function isRecentMetaAdsDate(dateKey, todayKey = localDateKey()) {
  const key = String(dateKey ?? "");
  return key >= shiftDateKey(todayKey, -1) && key <= todayKey;
}

function dateRangeKeys(fromKey, toKey) {
  let current = isValidDateKey(fromKey) ? String(fromKey) : localDateKey();
  const end = isValidDateKey(toKey) ? String(toKey) : localDateKey();
  if (current > end) return dateRangeKeys(end, current);

  const keys = [];
  while (current <= end) {
    keys.push(current);
    current = shiftDateKey(current, 1);
  }
  return keys;
}

function adsPresetRange(preset = "today") {
  const today = localDateKey();
  const key = ["today", "yesterday", "7d", "15d", "30d"].includes(String(preset)) ? String(preset) : "today";

  if (key === "yesterday") {
    const yesterday = shiftDateKey(today, -1);
    return { preset: key, fromDate: yesterday, toDate: yesterday, label: "Ayer" };
  }

  if (key === "7d") return { preset: key, fromDate: shiftDateKey(today, -6), toDate: today, label: "Ultimos 7 dias" };
  if (key === "15d") return { preset: key, fromDate: shiftDateKey(today, -14), toDate: today, label: "Ultimos 15 dias" };
  if (key === "30d") return { preset: key, fromDate: shiftDateKey(today, -29), toDate: today, label: "Ultimos 30 dias" };

  return { preset: "today", fromDate: today, toDate: today, label: "Hoy" };
}

function metaAdsAccountId() {
  return process.env.ZERNIO_META_ADS_ACCOUNT_ID || cachedMetaAdsAccountId || process.env.ZERNIO_ACCOUNT_ID || "";
}

async function resolveMetaAdsAccountId() {
  if (process.env.ZERNIO_META_ADS_ACCOUNT_ID) return process.env.ZERNIO_META_ADS_ACCOUNT_ID;
  if (cachedMetaAdsAccountId) return cachedMetaAdsAccountId;
  if (!process.env.ZERNIO_API_KEY) return process.env.ZERNIO_ACCOUNT_ID || "";

  try {
    const payload = await listZernioAccounts();
    const accounts = Array.isArray(payload?.accounts) ? payload.accounts : [];
    const metaAds = accounts.find((account) => account.platform === "metaads" && account.isActive !== false) ??
      accounts.find((account) => account.platform === "metaads");

    if (metaAds?._id) {
      cachedMetaAdsAccountId = metaAds._id;
      return cachedMetaAdsAccountId;
    }
  } catch (err) {
    console.warn("⚠️ Could not auto-detect Meta Ads account:", err.message);
  }

  return process.env.ZERNIO_ACCOUNT_ID || "";
}

async function resolvePrimaryAdAccountId(accountId) {
  const configuredId = primaryMetaAdAccountId();
  if (cachedPrimaryAdAccountId === configuredId) return cachedPrimaryAdAccountId;
  if (!accountId || !process.env.ZERNIO_API_KEY) return "";

  try {
    const payload = await listMetaAdAccounts({ accountId, limit: 100 });
    const accounts = Array.isArray(payload?.accounts) ? payload.accounts : [];
    const configuredAccount = accounts.find((account) => String(account?.id ?? "").trim() === configuredId);
    const match = selectPrimaryMetaAdAccount(accounts, configuredId);

    if (match?.id) {
      cachedPrimaryAdAccountId = match.id;
      cachedPrimaryAdAccountCurrency = match.currency || "";
      cachedPrimaryAdAccountName = match.name || DEFAULT_META_AD_ACCOUNT_NAME;
      return cachedPrimaryAdAccountId;
    }

    if (configuredAccount?.id) {
      console.warn(`⚠️ La cuenta Meta Ads ${configuredId} debe reportar en USD; Zernio informó ${configuredAccount.currency || "una moneda vacía"}.`);
      return "";
    }

    console.warn(`⚠️ No se encontró la cuenta Meta Ads ${configuredId} (${DEFAULT_META_AD_ACCOUNT_NAME}) entre ${accounts.length} cuentas disponibles.`);
    return "";
  } catch (err) {
    console.warn(`⚠️ Error al buscar cuenta Meta Ads primaria:`, err.message);
    return "";
  }
}

function pickDefaultAdAccount(adAccounts = []) {
  return selectPrimaryMetaAdAccount(adAccounts)?.id ?? "";
}

function whatsAppConversionAccountId(contact = {}) {
  return process.env.ZERNIO_WHATSAPP_ACCOUNT_ID || contact.accountId || contact.account_id || process.env.ZERNIO_ACCOUNT_ID || "";
}

function metaAdsDestinationId() {
  return String(process.env.META_ADS_DESTINATION_ID || getSetting("meta_ads_destination_id", "") || "").trim();
}

function adsTreeNodes(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.campaigns)) return payload.campaigns;
  if (Array.isArray(payload?.data?.campaigns)) return payload.data.campaigns;
  if (payload?.data && typeof payload.data === "object") return [payload.data];
  return [];
}

function collectAdsMetrics(node, totals) {
  if (!node || typeof node !== "object") return;

  const metrics = node.metrics && typeof node.metrics === "object" ? node.metrics : null;
  if (metrics) {
    totals.spend += Number(metrics.spend) || 0;
    totals.impressions += Number(metrics.impressions) || 0;
    totals.clicks += Number(metrics.clicks ?? metrics.linkClicks) || 0;
    totals.conversions += Number(metrics.conversions) || 0;
    totals.purchaseValue += Number(metrics.purchaseValue) || 0;
    if (!totals.currency && node.currency) totals.currency = String(node.currency);
    return;
  }

  const children = [
    ...(Array.isArray(node.adSets) ? node.adSets : []),
    ...(Array.isArray(node.adsets) ? node.adsets : []),
    ...(Array.isArray(node.ads) ? node.ads : []),
    ...(Array.isArray(node.children) ? node.children : []),
  ];

  for (const child of children) collectAdsMetrics(child, totals);
}

function aggregateAdsTreeMetrics(payload) {
  const totals = { spend: 0, impressions: 0, clicks: 0, conversions: 0, purchaseValue: 0, currency: "" };
  for (const node of adsTreeNodes(payload)) collectAdsMetrics(node, totals);

  totals.cpc = totals.clicks > 0 ? totals.spend / totals.clicks : 0;
  totals.cpm = totals.impressions > 0 ? (totals.spend / totals.impressions) * 1000 : 0;
  totals.roas = totals.spend > 0 ? totals.purchaseValue / totals.spend : 0;
  return totals;
}

function isEmptyMetaAdsMetrics(metrics = {}) {
  return !hasMetaAdsActivity(metrics);
}

function unavailableMetaAdsMetrics(date, existing = null, reason = "missing_recent_meta_ads_data") {
  return {
    date,
    adAccountId: existing?.adAccountId ?? primaryMetaAdAccountId(),
    adAccountName: existing?.adAccountName ?? cachedPrimaryAdAccountName ?? DEFAULT_META_AD_ACCOUNT_NAME,
    accountId: existing?.accountId ?? "",
    spend: Number(existing?.spend) || 0,
    impressions: Number(existing?.impressions) || 0,
    clicks: Number(existing?.clicks) || 0,
    conversions: Number(existing?.conversions) || 0,
    purchaseValue: Number(existing?.purchaseValue) || 0,
    roas: Number(existing?.roas) || 0,
    currency: existing?.currency ?? cachedPrimaryAdAccountCurrency ?? "",
    usdArsRate: Number(existing?.usdArsRate) || 0,
    rawJson: existing?.rawJson ?? "",
    updatedAt: existing?.updatedAt ?? "",
    isUnavailable: true,
    unavailableReason: reason,
  };
}

async function loadMetaAdsMetrics(date) {
  const dateKey = localDateKey(parseDateKey(date));
  const configuredAdAccountId = primaryMetaAdAccountId();
  const existing = getMetaAdsDailyMetrics(dateKey, configuredAdAccountId);

  if (isFutureDateKey(dateKey)) {
    return unavailableMetaAdsMetrics(dateKey, existing, "future_date");
  }

  const accountId = await resolveMetaAdsAccountId();
  if (!accountId || !process.env.ZERNIO_API_KEY) return existing;

  try {
    const adAccountId = await resolvePrimaryAdAccountId(accountId);
    if (!adAccountId) return unavailableMetaAdsMetrics(dateKey, existing, "primary_ad_account_unavailable");
    const timeline = await getAdsTimeline({ accountId, adAccountId, fromDate: dateKey, toDate: dateKey });
    const dayMetrics = Array.isArray(timeline?.rows) ? timeline.rows.find((row) => row.date === dateKey) : null;
    const payload = dayMetrics ? timeline : await getMetaAdsTree({ accountId, date: dateKey, adAccountId, source: process.env.ZERNIO_META_ADS_SOURCE || "all" });
    const metrics = dayMetrics ? {
      spend: Number(dayMetrics.spend) || 0,
      impressions: Number(dayMetrics.impressions) || 0,
      clicks: Number(dayMetrics.clicks) || 0,
      cpc: Number(dayMetrics.cpc) || 0,
      cpm: Number(dayMetrics.cpm) || 0,
      conversions: Number(dayMetrics.conversions) || 0,
      purchaseValue: Number(dayMetrics.purchaseValue) || 0,
      roas: Number(dayMetrics.roas) || 0,
      currency: cachedPrimaryAdAccountCurrency,
    } : aggregateAdsTreeMetrics(payload);

    if (!dayMetrics && isRecentMetaAdsDate(dateKey) && isEmptyMetaAdsMetrics(metrics)) {
      console.warn(`⚠️ Meta Ads metrics unavailable for ${dateKey}: Zernio returned no timeline row and empty tree metrics.`);
      return unavailableMetaAdsMetrics(dateKey, existing, "missing_recent_meta_ads_data");
    }

    upsertMetaAdsDailyMetrics(dateKey, {
      adAccountId,
      adAccountName: cachedPrimaryAdAccountName || DEFAULT_META_AD_ACCOUNT_NAME,
      accountId,
      ...metrics,
      currency: metrics.currency || cachedPrimaryAdAccountCurrency,
      usdArsRate: Math.max(1, Number(getSetting("usd_ars_rate", "1500")) || 1500),
      rawJson: payload,
    });
    return getMetaAdsDailyMetrics(dateKey, adAccountId);
  } catch (err) {
    console.warn(`⚠️ Could not refresh Meta Ads metrics for ${dateKey}:`, err.message);
    return unavailableMetaAdsMetrics(dateKey, existing, "refresh_failed");
  }
}

function metaAdsMetricsTtlMs(dateKey) {
  return dateKey === localDateKey() ? 120_000 : 21_600_000;
}

function refreshMetaAdsMetrics(date, options = {}) {
  const dateKey = localDateKey(parseDateKey(date));
  const adAccountId = primaryMetaAdAccountId();
  const refreshKey = `${adAccountId}:${dateKey}`;
  const existing = getMetaAdsDailyMetrics(dateKey, adAccountId);
  if (!options.force && existing && isFreshTimestamp(existing.updatedAt, metaAdsMetricsTtlMs(dateKey))) {
    return Promise.resolve(existing);
  }
  if (metaAdsRefreshes.has(refreshKey)) return metaAdsRefreshes.get(refreshKey);

  const request = loadMetaAdsMetrics(dateKey).finally(() => metaAdsRefreshes.delete(refreshKey));
  metaAdsRefreshes.set(refreshKey, request);
  return request;
}

async function refreshMetaAdsMetricsRange(fromDate, toDate, options = {}) {
  const dates = dateRangeKeys(fromDate, toDate).slice(-90);
  return mapWithConcurrency(dates, 4, (date) => refreshMetaAdsMetrics(date, options));
}

async function refreshLegacyMetaAdsMetrics() {
  const legacyRows = listUnassignedMetaAdsMetrics();
  if (!legacyRows.length) return [];

  return mapWithConcurrency(legacyRows, 4, async (legacy) => {
    await refreshMetaAdsMetrics(legacy.date, { force: true });
    const adAccountId = primaryMetaAdAccountId();
    const replacement = getMetaAdsDailyMetrics(legacy.date, adAccountId);
    if (!replacement) return;

    if (shouldReplaceLegacyMetaAdsMetrics(legacy, replacement)) {
      deleteUnassignedMetaAdsDailyMetrics(legacy.date);
    } else {
      deleteMetaAdsDailyMetrics(legacy.date, adAccountId);
    }
  });
}

function effectiveAdSpend(manualSpend, metaMetrics, usdArsRate = 1500) {
  const metaSpend = Math.round(metaSpendInArs(metaMetrics, usdArsRate));
  return metaSpend > 0 ? metaSpend : Math.round(Number(manualSpend) || 0);
}

function effectiveSpendSource(manualSpend, metaMetrics) {
  if (metaMetrics?.isUnavailable) return "Meta Ads sin datos recientes";
  return Number(metaMetrics?.spend) > 0 ? "Meta Ads en vivo" : Number(manualSpend) > 0 ? "Carga manual" : "Sin inversion";
}

function getActionCount(row, keys) {
  const actions = row?.actions && typeof row.actions === "object" ? row.actions : row && typeof row === "object" ? row : {};
  return keys.reduce((total, key) => total + (Number(actions[key]) || 0), 0);
}

function safeJsonParse(value) {
  if (!value) return null;
  if (typeof value === "object") return value;

  try {
    return JSON.parse(String(value));
  } catch {
    return null;
  }
}

function preferredMessagingConversationCount(row = {}) {
  const totalConnections = getActionCount(row, ["onsite_conversion.total_messaging_connection"]);
  if (totalConnections > 0) return totalConnections;

  return getActionCount(row, ["onsite_conversion.messaging_conversation_started_7d"]);
}

function metaMessagingConversationCount(metaMetrics = {}) {
  const raw = safeJsonParse(metaMetrics?.rawJson);
  const rows = Array.isArray(raw?.rows) ? raw.rows : [];

  if (rows.length) {
    return rows.reduce((total, row) => total + preferredMessagingConversationCount(row), 0);
  }

  return preferredMessagingConversationCount(raw ?? metaMetrics);
}

function sumAdsRows(rows = []) {
  const totals = {
    spend: 0,
    impressions: 0,
    reach: 0,
    clicks: 0,
    engagement: 0,
    conversions: 0,
    purchaseValue: 0,
    conversationsStarted: 0,
    firstReplies: 0,
    depth2: 0,
    depth3: 0,
    depth5: 0,
  };

  for (const row of rows) {
    totals.spend += Number(row.spend) || 0;
    totals.impressions += Number(row.impressions) || 0;
    totals.reach += Number(row.reach) || 0;
    totals.clicks += Number(row.clicks) || 0;
    totals.engagement += Number(row.engagement) || 0;
    totals.conversions += Number(row.conversions) || 0;
    totals.purchaseValue += Number(row.purchaseValue) || 0;
    totals.conversationsStarted += preferredMessagingConversationCount(row);
    totals.firstReplies += getActionCount(row, ["onsite_conversion.messaging_first_reply"]);
    totals.depth2 += getActionCount(row, ["onsite_conversion.messaging_user_depth_2_message_send"]);
    totals.depth3 += getActionCount(row, ["onsite_conversion.messaging_user_depth_3_message_send"]);
    totals.depth5 += getActionCount(row, ["onsite_conversion.messaging_user_depth_5_message_send"]);
  }

  totals.ctr = totals.impressions > 0 ? (totals.clicks / totals.impressions) * 100 : 0;
  totals.cpc = totals.clicks > 0 ? totals.spend / totals.clicks : 0;
  totals.cpm = totals.impressions > 0 ? (totals.spend / totals.impressions) * 1000 : 0;
  totals.roas = totals.spend > 0 ? totals.purchaseValue / totals.spend : 0;
  totals.costPerConversation = totals.conversationsStarted > 0 ? totals.spend / totals.conversationsStarted : 0;
  totals.costPerFirstReply = totals.firstReplies > 0 ? totals.spend / totals.firstReplies : 0;
  totals.costPerDepth3 = totals.depth3 > 0 ? totals.spend / totals.depth3 : 0;
  return totals;
}

function flattenAdsFromCampaigns(campaigns = []) {
  const ads = [];

  for (const campaign of campaigns) {
    for (const adSet of campaign.adSets ?? []) {
      for (const ad of adSet.ads ?? []) {
        ads.push({
          ...ad,
          campaignName: campaign.campaignName,
          platformCampaignId: campaign.platformCampaignId,
          adSetName: adSet.adSetName,
          platformAdSetId: adSet.platformAdSetId,
          adSetStatus: adSet.status,
          currency: campaign.currency,
          budget: ad.budget ?? adSet.budget ?? campaign.budget ?? campaign.campaignBudget,
          campaignBudget: campaign.campaignBudget ?? campaign.budget,
          adSetBudget: adSet.adSetBudget ?? adSet.budget,
          platformAdAccountId: campaign.platformAdAccountId,
          platformAdAccountName: campaign.platformAdAccountName,
          campaignStatus: campaign.status,
          platformCampaignStatus: campaign.platformCampaignStatus,
          reviewStatus: campaign.reviewStatus,
          platformObjective: campaign.platformObjective,
          optimizationGoal: ad.optimizationGoal ?? adSet.optimizationGoal ?? campaign.optimizationGoal,
          bidStrategy: ad.bidStrategy ?? adSet.bidStrategy ?? campaign.bidStrategy,
          bidAmount: ad.bidAmount ?? adSet.bidAmount ?? campaign.bidAmount,
          roasAverageFloor: ad.roasAverageFloor ?? adSet.roasAverageFloor ?? campaign.roasAverageFloor,
        });
      }
    }
  }

  return ads;
}

function adPerformanceAlert(adRow) {
  const spend = Number(adRow.spendArs) || 0;
  const crmChats = Number(adRow.crmChats) || 0;
  const interested = Number(adRow.crmInterested) || 0;
  const sales = Number(adRow.crmSales) || 0;
  const metaChats = Number(adRow.metaConversations) || 0;
  const costPerChat = crmChats ? spend / crmChats : 0;

  if (spend > 15000 && crmChats === 0) return { tone: "danger", label: "Gasta sin chats CRM" };
  if (metaChats >= 10 && crmChats === 0) return { tone: "danger", label: "Meta trae, CRM no atribuye" };
  if (crmChats >= 5 && interested / crmChats < 0.2) return { tone: "warn", label: "Chats de baja calidad" };
  if (interested >= 3 && sales === 0) return { tone: "warn", label: "Interés sin cierre" };
  if (sales > 0 && adRow.realRoas >= 1) return { tone: "good", label: "Rinde" };
  if (costPerChat > 3000) return { tone: "warn", label: "Costo por chat alto" };
  return { tone: "neutral", label: "Monitorear" };
}

function conversationQualityCounts(conversations = []) {
  const counts = { noReply: 0, oneReply: 0, twoReplies: 0, threePlus: 0, sales: 0 };

  for (const conversation of conversations) {
    const replies = Number(conversation.leadReplyCount) || 0;
    if (Number(conversation.paymentCount) > 0) counts.sales += 1;
    if (replies <= 0) counts.noReply += 1;
    else if (replies === 1) counts.oneReply += 1;
    else if (replies === 2) counts.twoReplies += 1;
    else counts.threePlus += 1;
  }

  return counts;
}

function sumQualityCounts(rows = []) {
  return rows.reduce(
    (total, row) => ({
      noReply: total.noReply + (row.quality?.noReply ?? 0),
      oneReply: total.oneReply + (row.quality?.oneReply ?? 0),
      twoReplies: total.twoReplies + (row.quality?.twoReplies ?? 0),
      threePlus: total.threePlus + (row.quality?.threePlus ?? 0),
      sales: total.sales + (row.quality?.sales ?? 0),
    }),
    { noReply: 0, oneReply: 0, twoReplies: 0, threePlus: 0, sales: 0 }
  );
}

function formatAdMoney(value, currency = "") {
  const amount = Number(value) || 0;
  const suffix = currency ? ` ${currency}` : "";
  return `${amount.toLocaleString("es-AR", { minimumFractionDigits: amount % 1 ? 2 : 0, maximumFractionDigits: 2 })}${suffix}`;
}

function monthRange(dateKey = localDateKey()) {
  const key = /^\d{4}-\d{2}-\d{2}$/.test(String(dateKey)) ? String(dateKey) : localDateKey();
  return { fromDate: `${key.slice(0, 8)}01`, toDate: key, label: "Mes actual" };
}

function normalizeMetaStatus(value) {
  return String(value ?? "").trim().toLowerCase();
}

function statusTone(value) {
  const status = normalizeMetaStatus(value);
  if (["active", "approved"].includes(status)) return "good";
  if (["paused", "inactive", "deleted", "archived", "disabled", "rejected"].includes(status)) return "danger";
  if (["in_review", "pending", "limited"].includes(status)) return "warn";
  return status ? "neutral" : "warn";
}

function statusLabel(value) {
  const status = normalizeMetaStatus(value);
  if (status === "active") return "Activo";
  if (status === "paused") return "Pausado";
  if (status === "inactive") return "Inactivo";
  if (status === "approved") return "Aprobado";
  if (status === "rejected") return "Rechazado";
  if (status === "in_review") return "En revisión";
  return status ? status.replaceAll("_", " ") : "Sin dato";
}

function adStatusSummary(ad = {}) {
  const adStatus = ad.status || ad.effectiveStatus;
  const campaignStatus = ad.platformCampaignStatus || ad.campaignStatus;
  const adTone = statusTone(adStatus);
  const campaignTone = statusTone(campaignStatus);
  const tone = [adTone, campaignTone, statusTone(ad.adSetStatus)].includes("danger") ? "danger" : [adTone, campaignTone].includes("warn") ? "warn" : adTone;

  return {
    tone,
    ad: statusLabel(adStatus),
    adSet: statusLabel(ad.adSetStatus),
    campaign: statusLabel(campaignStatus),
    review: statusLabel(ad.reviewStatus),
    isActive: normalizeMetaStatus(adStatus) === "active" && normalizeMetaStatus(campaignStatus || "active") === "active",
  };
}

function adCostPerChat(ad = {}) {
  return ad.crmChats ? (Number(ad.spendArs) || 0) / ad.crmChats : 0;
}

function adWinnerScore(ad = {}) {
  const spend = Number(ad.spendArs) || 0;
  const chats = Number(ad.crmChats) || 0;
  const sales = Number(ad.crmSales) || 0;
  const interested = Number(ad.crmInterested) || 0;
  const roas = Number(ad.realRoas) || 0;
  const costPerChat = adCostPerChat(ad);
  const noReply = Number(ad.quality?.noReply) || 0;
  let score = 0;

  score += sales * 70;
  score += Math.min(roas, 4) * 28;
  score += interested * 8;
  score += chats * 2;
  score -= noReply * 3;
  if (costPerChat > 0) score -= Math.min(25, costPerChat / 250);
  if (spend > 8000 && chats === 0) score -= 45;
  if (spend > 12000 && sales === 0) score -= 28;
  if (ad.statusInfo && !ad.statusInfo.isActive) score -= 10;
  return Math.round(score * 10) / 10;
}

function buildBidRecommendation(ad = {}) {
  const strategy = String(ad.bidStrategy ?? "").replaceAll("_", " ") || "sin dato";
  const budget = ad.budget?.amount ? `${formatAdMoney(ad.budget.amount, ad.currency)} ${ad.budget.type ?? ""}`.trim() : "sin presupuesto visible";
  const costPerChat = adCostPerChat(ad);
  const sales = Number(ad.crmSales) || 0;
  const chats = Number(ad.crmChats) || 0;
  const interested = Number(ad.crmInterested) || 0;
  const roas = Number(ad.realRoas) || 0;

  if (!ad.statusInfo?.isActive && (sales > 0 || roas >= 1)) {
    return `Ganador pausado/inactivo: duplicar o reactivar con bajo riesgo. Mantener ${strategy}; presupuesto actual ${budget}.`;
  }

  if (sales > 0 && roas >= 1 && costPerChat > 0 && costPerChat <= 2500) {
    return `Escalar gradual +20% a +30% y mantener ${strategy}. No tocar creatividad mientras conserve chat barato y ROAS positivo.`;
  }

  if (interested >= 3 && sales === 0) {
    return `No subir puja todavía. Hay intención, pero falta cierre: revisar seguimiento/comprobante antes de escalar presupuesto.`;
  }

  if (chats >= 5 && interested / Math.max(chats, 1) < 0.25) {
    return `Bajar presupuesto o pausar test. Chat barato sin calidad suele empeorar ROAS; probar nuevo creativo/segmento.`;
  }

  if ((Number(ad.spendArs) || 0) > 12000 && chats === 0) {
    return `Pausar o limitar. Está gastando sin chats atribuidos al CRM; validar tracking antes de cambiar puja.`;
  }

  return `Monitorear con ${strategy}. Esperar más volumen antes de subir puja; presupuesto actual ${budget}.`;
}

function sortAdsByWinner(a, b) {
  const scoreDiff = (b.winnerScore || 0) - (a.winnerScore || 0);
  if (scoreDiff !== 0) return scoreDiff;
  const salesDiff = (b.crmSales || 0) - (a.crmSales || 0);
  if (salesDiff !== 0) return salesDiff;
  const roasDiff = (b.realRoas || 0) - (a.realRoas || 0);
  if (roasDiff !== 0) return roasDiff;
  return (b.spendArs || 0) - (a.spendArs || 0);
}

function buildAdRowsFromCampaigns(campaigns = [], attributed = [], attributedPayments = [], usdArsRate = 1500) {
  const attributionByAdId = new Map();
  for (const conversation of attributed) {
    const key = String(conversation.ctwaSourceId ?? "");
    if (!key) continue;
    const bucket = attributionByAdId.get(key) ?? [];
    bucket.push(conversation);
    attributionByAdId.set(key, bucket);
  }

  const paymentsByAdId = new Map();
  for (const payment of attributedPayments) {
    const key = String(payment.ctwaSourceId ?? "");
    if (!key) continue;
    const bucket = paymentsByAdId.get(key) ?? [];
    bucket.push(payment);
    paymentsByAdId.set(key, bucket);
  }

  return flattenAdsFromCampaigns(campaigns)
    .filter((ad) => (Number(ad.metrics?.spend) || 0) > 0 || attributionByAdId.has(String(ad.platformAdId)) || paymentsByAdId.has(String(ad.platformAdId)))
    .map((ad) => {
      const conversations = attributionByAdId.get(String(ad.platformAdId)) ?? [];
      const payments = paymentsByAdId.get(String(ad.platformAdId)) ?? [];
      const currency = String(ad.currency ?? "").toUpperCase();
      const spend = Number(ad.metrics?.spend) || 0;
      const spendArs = currency === "USD" ? spend * usdArsRate : spend;
      const revenue = payments.reduce((total, payment) => total + (Number(payment.amount) || 0), 0);
      const sales = payments.length;
      const interested = conversations.filter((conversation) => (Number(conversation.leadReplyCount) || 0) >= 2).length;
      const quality = conversationQualityCounts(conversations);
      quality.sales = sales;
      const row = {
        ...ad,
        spend,
        spendArs,
        crmChats: conversations.length,
        crmInterested: interested,
        crmSales: sales,
        crmRevenue: revenue,
        quality,
        crmCpa: sales ? spendArs / sales : 0,
        realRoas: spendArs > 0 ? revenue / spendArs : 0,
        metaConversations: preferredMessagingConversationCount(ad.metrics),
        attributedConversations: conversations,
        attributedPayments: payments,
      };
      row.statusInfo = adStatusSummary(row);
      row.alert = adPerformanceAlert(row);
      row.winnerScore = adWinnerScore(row);
      row.bidRecommendation = buildBidRecommendation(row);
      return row;
    })
    .sort(sortAdsByWinner);
}

function localHour(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const hour = new Intl.DateTimeFormat("en-GB", { timeZone: "America/Argentina/Buenos_Aires", hour: "2-digit", hour12: false }).format(date);
  return Math.max(0, Math.min(23, Number(hour) || 0));
}

function hourBlockLabel(startHour) {
  const start = String(startHour).padStart(2, "0");
  const end = String((startHour + 3) % 24).padStart(2, "0");
  return `${start}:00-${end}:00`;
}

function buildHourlyInsights(stats = {}) {
  const buckets = new Map();
  const ensure = (hour) => {
    const start = Math.floor(hour / 3) * 3;
    const current = buckets.get(start) ?? { startHour: start, label: hourBlockLabel(start), sales: 0, revenue: 0, replies: 0, score: 0 };
    buckets.set(start, current);
    return current;
  };

  for (const sale of stats.sales ?? []) {
    const hour = localHour(sale.at);
    if (hour === null) continue;
    const bucket = ensure(hour);
    bucket.sales += 1;
    bucket.revenue += Number(sale.amount) || 0;
  }

  for (const reply of stats.replies ?? []) {
    const hour = localHour(reply.at);
    if (hour === null) continue;
    ensure(hour).replies += 1;
  }

  const rows = [...buckets.values()].map((bucket) => ({
    ...bucket,
    score: bucket.sales * 8 + bucket.revenue / 5000 + bucket.replies * 0.35,
  })).sort((a, b) => b.score - a.score);

  const timeline = Array.from({ length: 8 }, (_, index) => {
    const start = index * 3;
    const bucket = buckets.get(start) ?? { startHour: start, label: hourBlockLabel(start), sales: 0, revenue: 0, replies: 0, score: 0 };
    return {
      ...bucket,
      score: bucket.score || bucket.sales * 8 + bucket.revenue / 5000 + bucket.replies * 0.35,
    };
  });

  return {
    rows,
    timeline,
    best: rows[0] ?? null,
    confidence: rows.reduce((total, row) => total + row.sales, 0) >= 10 ? "media" : "baja",
  };
}

function buildAdsRecommendations(adRows = [], monthlyRows = [], hourly = {}) {
  const winner = monthlyRows.find((ad) => ad.crmSales > 0 && ad.realRoas >= 1) ?? monthlyRows[0];
  const loser = [...adRows]
    .filter((ad) => (Number(ad.spendArs) || 0) > 8000 && ad.crmSales === 0)
    .sort((a, b) => (b.spendArs || 0) - (a.spendArs || 0))[0];
  const bestHour = hourly.best;
  const recommendations = [];

  if (winner) recommendations.push(`Escalar primero: ${winner.name ?? "anuncio"}. Score ${winner.winnerScore}, ${winner.crmSales} ventas, ROAS cohorte ${formatMultiple(winner.realRoas)}.`);
  if (loser) recommendations.push(`Reducir riesgo: ${loser.name ?? "anuncio"} gastó ${formatAdMoney(loser.spend, loser.currency)} sin ventas CRM. Pausar o bajar presupuesto antes de subir puja.`);
  if (bestHour) recommendations.push(`Franja con mejor señal: ${bestHour.label} hora Argentina. Concentrar tests y presupuesto ahí; confianza ${hourly.confidence}.`);
  if (!recommendations.length) recommendations.push("Todavía falta volumen para una recomendación fuerte. Mantener presupuesto controlado y juntar más ventas atribuidas.");

  return recommendations;
}

async function buildAdsDashboard(req) {
  const accountId = await resolveMetaAdsAccountId();
  const range = adsPresetRange(req.query.adsPreset ?? "today");
  const fromDate = range.fromDate;
  const toDate = range.toDate;
  const configuredAdAccountId = primaryMetaAdAccountId();

  const empty = {
    accountId,
    adAccounts: [],
    selectedAdAccountId: configuredAdAccountId,
    preset: range.preset,
    presetLabel: range.label,
    fromDate,
    toDate,
    rows: [],
    totalsByCurrency: [],
    campaigns: [],
    adRows: [],
    monthlyAdRows: [],
    monthRange: { fromDate, toDate, label: range.label },
    hourlyInsights: { rows: [], best: null, confidence: "baja" },
    recommendations: [],
    totalPayments: [],
    attributedPayments: [],
    paidPeriodAttributedPayments: [],
    monthlyAttributedPayments: [],
    error: "",
  };

  if (!accountId || !process.env.ZERNIO_API_KEY) {
    return { ...empty, error: "Falta ZERNIO_API_KEY o cuenta Meta Ads conectada." };
  }

  try {
    const adAccountsPayload = await listMetaAdAccounts({ accountId, limit: 100 });
    const adAccounts = Array.isArray(adAccountsPayload?.accounts) ? adAccountsPayload.accounts : [];
    const selectedAdAccountId = pickDefaultAdAccount(adAccounts);

    if (!selectedAdAccountId) {
      return { ...empty, error: `No se encontró la cuenta '${DEFAULT_META_AD_ACCOUNT_NAME}' (${configuredAdAccountId}). Verificá que esté activa en Meta Ads.` };
    }

    const selectedAccounts = adAccounts.filter((account) => account.id === selectedAdAccountId);
    const rowsByCurrency = new Map();

    const timelines = await mapWithConcurrency(selectedAccounts, 4, async (adAccount) => ({
      adAccount,
      timeline: await getAdsTimeline({ accountId, adAccountId: adAccount.id, fromDate, toDate }),
    }));
    for (const { adAccount, timeline } of timelines) {
      for (const row of Array.isArray(timeline?.rows) ? timeline.rows : []) {
        const enriched = { ...row, adAccountId: adAccount.id, adAccountName: adAccount.name, currency: adAccount.currency || "" };
        const key = enriched.currency || "sin moneda";
        rowsByCurrency.set(key, [...(rowsByCurrency.get(key) ?? []), enriched]);
      }
    }

    const allRows = [...rowsByCurrency.values()].flat();
    const totalsByCurrency = [...rowsByCurrency.entries()].map(([currency, rows]) => ({ currency, rows, totals: sumAdsRows(rows) }));
    const tree = await getMetaAdsTree({
      accountId,
      adAccountId: selectedAdAccountId,
      fromDate,
      toDate,
      source: process.env.ZERNIO_META_ADS_SOURCE || "all",
      sort: "spend_desc",
    });
    const campaigns = Array.isArray(tree?.campaigns) ? tree.campaigns : adsTreeNodes(tree);
    const usdArsRate = Math.max(1, Number(getSetting("usd_ars_rate", "1500")) || 1500);
    const attributed = listCtwaAttributedConversations({ from: fromDate, to: toDate });
    const paidPeriodAttributedPayments = listCtwaAttributedPayments({ from: fromDate, to: toDate });
    const attributedPayments = listCtwaCohortAttributedPayments({ from: fromDate, to: toDate });
    const totalPayments = listPayments({ from: fromDate, to: toDate });
    const adRows = buildAdRowsFromCampaigns(campaigns, attributed, attributedPayments, usdArsRate);
    const paymentsWithSource = new Set(paidPeriodAttributedPayments.map((payment) => payment.id));
    const currentAdIds = new Set(flattenAdsFromCampaigns(campaigns).map((ad) => String(ad.platformAdId ?? "")));
    const pendingAttributionPayments = totalPayments.filter((payment) => !paymentsWithSource.has(payment.id));
    const unassignedAttributionPayments = paidPeriodAttributedPayments.filter((payment) => !currentAdIds.has(String(payment.ctwaSourceId ?? "")));
    const periodRange = { fromDate, toDate, label: range.label };
    const hourlyInsights = buildHourlyInsights(listCtwaHourlyStats({ from: fromDate, to: toDate }));
    const recommendations = buildAdsRecommendations(adRows, adRows, hourlyInsights);

    latestAdsDashboard = { ...empty, selectedAdAccountId, adAccounts: selectedAccounts, rows: allRows, totalsByCurrency, campaigns, adRows, monthlyAdRows: adRows, monthRange: periodRange, hourlyInsights, recommendations, totalPayments, attributedPayments, monthlyAttributedPayments: attributedPayments, paidPeriodAttributedPayments, pendingAttributionPayments, unassignedAttributionPayments, error: "" };
    return latestAdsDashboard;
  } catch (err) {
    console.warn("⚠️ Could not build Ads dashboard:", err.message);
    latestAdsDashboard = { ...empty, error: err.message };
    return latestAdsDashboard;
  }
}

function cachedAdsDashboard(req, options = {}) {
  const range = adsPresetRange(req.query.adsPreset ?? "today");
  const revision = getAdminRevision();
  const key = [
    range.fromDate,
    range.toDate,
    primaryMetaAdAccountId(),
    process.env.ZERNIO_META_ADS_ACCOUNT_ID ?? "auto",
    process.env.ZERNIO_META_ADS_SOURCE ?? "all",
    getSetting("usd_ars_rate", "1500"),
    revision.updatedAt,
    revision.metaUpdatedAt,
    revision.conversations,
    revision.payments,
    revision.paymentTotal,
  ].join(":");
  return adsDashboardCache.getOrLoad(key, () => buildAdsDashboard(req), {
    ...options,
    shouldCache: (dashboard) => !dashboard?.error,
  });
}

async function backfillCtwaAttributionImpl(options = {}) {
  if (!process.env.ZERNIO_API_KEY) return { pages: 0, conversations: 0, attributed: 0, saved: 0, errors: [] };

  const targets = [];
  const addTarget = (accountId, platform) => {
    const id = String(accountId ?? "").trim();
    const channel = normalizeChannel(platform);
    if (!id) return;
    if (!targets.some((target) => target.accountId === id && target.platform === channel)) targets.push({ accountId: id, platform: channel });
  };

  for (const target of options.targets ?? []) addTarget(target.accountId, target.platform);
  if (!targets.length) addTarget(process.env.ZERNIO_WHATSAPP_ACCOUNT_ID || process.env.ZERNIO_ACCOUNT_ID, "whatsapp");

  if (!options.targets?.length) try {
    const accountsPayload = await listZernioAccounts();
    const accounts = Array.isArray(accountsPayload?.accounts) ? accountsPayload.accounts : [];
    for (const account of accounts) {
      const rawPlatform = String(account.platform ?? "").toLowerCase();
      const platform = rawPlatform.includes("instagram") ? "instagram" : rawPlatform.includes("facebook") ? "facebook" : rawPlatform.includes("whatsapp") ? "whatsapp" : "";
      if (["whatsapp", "instagram", "facebook"].includes(platform) && account.isActive !== false) addTarget(account._id, platform);
    }
  } catch (err) {
    console.warn("⚠️ Could not list accounts for Meta attribution backfill:", err.message);
  }

  let pages = 0;
  let conversationsRead = 0;
  let attributed = 0;
  let saved = 0;
  const errors = [];
  const maxPages = Math.max(1, Number(options.maxPages) || 1);

  for (const target of targets) {
    try {
      const result = await consumeInboxConversationPages(
        ({ limit, cursor }) => listInboxConversations({ accountId: target.accountId, platform: target.platform, limit, cursor }),
        {
          limit: options.limit || 100,
          maxPages,
            onPage: (conversations) => {
              for (const conversation of conversations) {
                if (!shouldProcessCtwaBackfillConversation(conversation, options)) continue;
                const attribution = extractCtwaAttribution({ conversation });
              if (!attribution?.ctwaSourceId) continue;
              attributed += 1;

              const participantId = firstValue(conversation.participantPhoneNumber, conversation.participantId, conversation.participantUsername);
              if (!participantId && !conversation.id) continue;
              const contactId = target.platform === "whatsapp"
                ? String(participantId).replace(/^\+/, "")
                : `${target.platform === "facebook" ? "fb" : "ig"}:${participantId || conversation.id}`;
              const username = firstValue(conversation.participantUsername, conversation.participantName);
              const displayHandle = target.platform === "instagram" && username ? `@${username.replace(/^@+/, "")}` : username;

              if (saveContactCtwaAttribution(contactId, {
                ...attribution,
                channel: target.platform,
                conversationId: conversation.id,
                accountId: conversation.accountId || target.accountId,
                externalId: participantId,
                displayHandle,
                name: conversation.participantName || username,
                conversationUrl: conversation.url,
              })) saved += 1;
            }
          },
        }
      );
      pages += result.pages;
      conversationsRead += result.conversations;
      if (result.truncated) errors.push(`${target.platform}: se alcanzó el límite de ${maxPages} páginas`);
    } catch (err) {
      errors.push(`${target.platform}:${err.message}`);
      console.warn(`⚠️ Could not backfill ${target.platform} attribution:`, err.message);
    }
  }

  return { pages, conversations: conversationsRead, attributed, saved, errors };
}

function backfillCtwaAttribution(options = {}) {
  return trackContactOperation(() => backfillCtwaAttributionImpl(options));
}

function queueCtwaAttributionRecovery(phoneNumber, contact) {
  const sourceId = contact.ctwa_source_id ?? contact.ctwaSourceId;
  const conversationId = contact.conversation_id ?? contact.conversationId;
  const accountId = contact.account_id ?? contact.accountId;
  if (sourceId || !conversationId || ctwaRecoveryTimers.has(phoneNumber)) return;

  const target = {
    accountId: accountId || process.env.ZERNIO_WHATSAPP_ACCOUNT_ID || process.env.ZERNIO_ACCOUNT_ID,
    platform: contact.channel || "whatsapp",
  };
  const delays = [0, 5 * 60_000, 30 * 60_000];
  const maxPages = Math.max(1, Number(process.env.CTWA_PAYMENT_RECOVERY_MAX_PAGES) || 10);
  let attempt = 0;

  const recover = async () => {
    const current = getContact(phoneNumber);
    if (current.ctwa_source_id || !current.conversation_id) {
      ctwaRecoveryTimers.delete(phoneNumber);
      return;
    }

    try {
      await backfillCtwaAttribution({
        targets: [target],
        conversationIds: [current.conversation_id],
        maxPages,
      });
      if (getContact(phoneNumber).ctwa_source_id) {
        console.log(`📈 CTWA attribution recovered for paid contact ${phoneNumber}`);
      }
    } catch (err) {
      console.warn(`⚠️ CTWA attribution recovery failed for ${phoneNumber}:`, err.message);
    }

    attempt += 1;
    if (attempt >= delays.length || getContact(phoneNumber).ctwa_source_id) {
      ctwaRecoveryTimers.delete(phoneNumber);
      return;
    }
    ctwaRecoveryTimers.set(phoneNumber, scheduleRecovery(delays[attempt]));
  };

  const scheduleRecovery = (delay) => setTimeout(() => {
    trackContactOperation(recover).catch((err) => {
      console.warn(`⚠️ CTWA attribution recovery task failed for ${phoneNumber}:`, err.message);
    });
  }, delay);

  ctwaRecoveryTimers.set(phoneNumber, scheduleRecovery(delays[attempt]));
}

function queueRecentCtwaAttributionRecovery() {
  const since = new Date(Date.now() - 72 * 60 * 60_000).toISOString();
  for (const contact of listRecentPaidContactsMissingCtwaAttribution({ since })) {
    queueCtwaAttributionRecovery(contact.phoneNumber, contact);
  }
}

function phoneDigits(value) {
  return String(value ?? "").replace(/\D/g, "");
}

async function sendPurchaseConversionForPayment(paymentId, phoneNumber, details = {}) {
  const eventId = `purchase_${paymentId}`;
  const existing = getMetaConversionEvent(eventId);
  if (existing?.status === "sent") return;

  const contact = details.contact ?? getContact(phoneNumber);
  const conversationId = details.conversationId || contact.conversation_id || contact.conversationId || "";
  const currency = process.env.META_CONVERSION_CURRENCY || "ARS";
  const value = Number(details.amount) || 0;
  const channel = contact.channel || "whatsapp";

  if (channel !== "whatsapp") {
    const accountId = await resolveMetaAdsAccountId();
    const destinationId = metaAdsDestinationId();

    if (!accountId || !destinationId || !process.env.ZERNIO_API_KEY) {
      upsertMetaConversionEvent({
        eventId,
        paymentId,
        phoneNumber,
        accountId,
        conversationId,
        eventName: "Purchase",
        value,
        currency,
        status: "skipped",
        error: "Falta ZERNIO_API_KEY, cuenta Meta Ads o META_ADS_DESTINATION_ID/meta_ads_destination_id",
      });
      return;
    }

    upsertMetaConversionEvent({
      eventId,
      paymentId,
      phoneNumber,
      accountId,
      conversationId,
      eventName: "Purchase",
      value,
      currency,
      status: "pending",
    });

    try {
      const response = await sendAdsConversion({
        accountId,
        destinationId,
        conversationId,
        eventName: "Purchase",
        eventId,
        value,
        currency,
        eventTime: new Date().toISOString(),
        testCode: process.env.META_CONVERSION_TEST_CODE || "",
        clickId: contact.ctwa_clid || "",
        adId: contact.ctwa_source_id || "",
        userData: {
          externalId: contact.external_id || contact.externalId || phoneNumber,
        },
        customData: {
          value,
          currency,
          channel,
          conversationId,
          adId: contact.ctwa_source_id || "",
        },
      });

      upsertMetaConversionEvent({
        eventId,
        paymentId,
        phoneNumber,
        accountId,
        conversationId,
        eventName: "Purchase",
        value,
        currency,
        status: "sent",
        responseJson: response,
        sentAt: new Date().toISOString(),
      });
      console.log(`📈 Meta Ads Purchase conversion sent for payment ${paymentId}: ${eventId}`);
    } catch (err) {
      upsertMetaConversionEvent({
        eventId,
        paymentId,
        phoneNumber,
        accountId,
        conversationId,
        eventName: "Purchase",
        value,
        currency,
        status: "failed",
        responseJson: err.response,
        error: err.message,
      });
      console.warn(`⚠️ Meta Ads Purchase conversion failed for payment ${paymentId}:`, err.message);
    }
    return;
  }

  const accountId = whatsAppConversionAccountId(contact);

  if (!accountId || !process.env.ZERNIO_API_KEY) {
    upsertMetaConversionEvent({
      eventId,
      paymentId,
      phoneNumber,
      accountId,
      conversationId,
      eventName: "Purchase",
      value,
      currency,
      status: "skipped",
      error: "Falta ZERNIO_API_KEY o ZERNIO_WHATSAPP_ACCOUNT_ID/ZERNIO_ACCOUNT_ID",
    });
    return;
  }

  upsertMetaConversionEvent({
    eventId,
    paymentId,
    phoneNumber,
    accountId,
    conversationId,
    eventName: "Purchase",
    value,
    currency,
    status: "pending",
  });

  try {
    await ensureWhatsAppDataset({ accountId });
    const response = await sendWhatsAppConversion({
      accountId,
      conversationId,
      phoneE164: conversationId ? "" : phoneDigits(phoneNumber),
      eventName: "Purchase",
      eventId,
      value,
      currency,
      testCode: process.env.META_CONVERSION_TEST_CODE || "",
    });

    upsertMetaConversionEvent({
      eventId,
      paymentId,
      phoneNumber,
      accountId,
      conversationId,
      eventName: "Purchase",
      value,
      currency,
      status: "sent",
      responseJson: response,
      sentAt: new Date().toISOString(),
    });
    console.log(`📈 Meta Purchase conversion sent for payment ${paymentId}: ${eventId}`);
  } catch (err) {
    upsertMetaConversionEvent({
      eventId,
      paymentId,
      phoneNumber,
      accountId,
      conversationId,
      eventName: "Purchase",
      value,
      currency,
      status: "failed",
      responseJson: err.response,
      error: err.message,
    });
    console.warn(`⚠️ Meta Purchase conversion failed for payment ${paymentId}:`, err.message);
  }
}

function formatDateLong(dateKey) {
  return parseDateKey(dateKey).toLocaleDateString("es-AR", {
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric",
  });
}

function formatDashboardDate(dateKey) {
  return parseDateKey(dateKey).toLocaleDateString("es-AR", {
    weekday: "long",
    day: "2-digit",
    month: "long",
  });
}

function formatPercent(value) {
  if (!Number.isFinite(value)) return "-";
  return `${Math.round(value)}%`;
}

function formatMultiple(value) {
  if (!Number.isFinite(value)) return "-";
  return `${value.toFixed(value >= 10 ? 1 : 2)}x`;
}

function formatRelativeTime(value) {
  if (!value) return "sin actividad";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "sin actividad";

  const diffMs = Date.now() - date.getTime();
  const minutes = Math.max(0, Math.floor(diffMs / 60_000));

  if (minutes < 1) return "recién";
  if (minutes < 60) return `hace ${minutes} min`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;

  const days = Math.floor(hours / 24);
  return `hace ${days} d`;
}

function isToday(value) {
  if (!value) return false;

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;

  const today = new Date();
  return (
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate()
  );
}

function sumMoney(rows, key = "amount") {
  return rows.reduce((total, row) => total + (Number(row[key]) || 0), 0);
}

function activeAdminSection(req) {
  const section = String(req.query.section ?? "dashboard");
  return ADMIN_SECTIONS.has(section) ? section : "dashboard";
}

function adminConversationQuery(req) {
  return buildAdminConversationQuery(req.query, localDateKey());
}

function adminSectionPath(req, section, extra = {}) {
  const params = new URLSearchParams();
  const token = getAdminToken(req);

  if (token) params.set("token", token);
  params.set("section", section);

  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined && value !== null && value !== "") params.set(key, value);
  }

  return `/admin?${params.toString()}`;
}

function adminHiddenFields(req, extra = {}) {
  const fields = [];
  const token = getAdminToken(req);

  if (token) fields.push(`<input type="hidden" name="token" value="${escapeHtml(token)}">`);

  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined && value !== null && value !== "") {
      fields.push(`<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}">`);
    }
  }

  return fields.join("");
}

function adminStatusMessage(status) {
  const messages = {
    bot_paused: "Bot pausado para seguimiento humano.",
    bot_resolved: "Bot reactivado para ese contacto.",
    bot_all_resolved: "Todos los chats en revision fueron devueltos al bot.",
    paid_link_sent: "Pago guardado y link del producto enviado por WhatsApp.",
    paid_already_sent: "Pago guardado. El link ya habia sido enviado antes, no se duplico.",
    paid_no_conversation: "Pago guardado, pero no pude enviar el link porque falta conversationId.",
    release_no_conversation: "No pude liberar el producto porque falta conversationId.",
    paid_send_failed: "Pago guardado, pero fallo el envio del link. Revisá la consola y las credenciales de Zernio.",
    unpaid: "Estado de comprador quitado. El historial de ingresos se conserva.",
    conversion_reverted: "Conversión revertida y el ingreso fue quitado de los reportes.",
    conversion_revert_missing: "No encontré un ingreso para revertir en esta conversación.",
    ctwa_backfill_completed: "Atribución CTWA actualizada.",
    ctwa_backfill_partial: "Atribución CTWA actualizada parcialmente. Revisá los errores informados.",
    settings_saved: "Configuracion guardada.",
    ad_spend_saved: "Inversion diaria guardada.",
    revenue_adjusted: "Ajuste de facturacion guardado.",
    revenue_adjust_failed: "No se guardo el ajuste. Revisá confirmacion, motivo y monto.",
    promo_offered: "Producto liberado manualmente.",
    flash_offered: "Bombazo enviado manualmente.",
    promo_send_failed: "Fallo el envio de la liberacion. Revisá la consola.",
    contact_deleted: "Conversacion eliminada.",
    contacts_purged: "Historial de contactos eliminado.",
    contacts_purge_failed: "No se eliminó el historial. Escribí BORRAR TODO para confirmar.",
    trigger_flow_started: "Flujo iniciado correctamente.",
    trigger_flow_no_contact: "No se encontró el contacto.",
  };

  return messages[status] ?? "";
}

function statusBadge(conversation, req) {
  if (conversation.handoff) return `<span class="badge badge-warn">Revision humana</span>`;
  if (conversation.paid) return `<span class="badge badge-good">Cliente pago</span>`;
  if (conversation.promoSent) return `<span class="badge badge-soft">Producto liberado</span>`;
  const pauseFields = adminHiddenFields(req, { section: req?.query?.section ?? "conversations" });
  return `<span class="badge badge-neutral">Bot activo</span><form method="post" action="/admin/handoffs" class="pause-inline">${pauseFields}<input type="hidden" name="phoneNumber" value="${escapeHtml(conversation.phoneNumber)}"><input type="hidden" name="reason" value="Pausado desde estado"><button type="submit" class="pause-btn" title="Pausar bot">⏸</button></form>`;
}

function channelBadge(conversation) {
  const channel = conversation.channel === "instagram" ? "Instagram" : conversation.channel === "facebook" ? "Facebook" : "WhatsApp";
  const tone = conversation.channel === "instagram" ? "soft" : conversation.channel === "facebook" ? "warn" : "good";
  return `<span class="badge badge-${tone}">${channel}</span>`;
}

function contactDisplayName(conversation) {
  return conversation.displayHandle || conversation.name || conversation.phoneNumber;
}

function leadInterest(conversation) {
  const replies = Number(conversation.leadReplyCount) || 0;
  if (replies >= 3) return { label: "Muy interesado", detail: `${replies} respuestas`, tone: "good", token: "interest-3plus" };
  if (replies === 2) return { label: "Interesado", detail: "2 respuestas", tone: "warn", token: "interest-2" };
  if (replies === 1) return { label: "Tibio", detail: "1 respuesta", tone: "soft", token: "interest-1" };
  return { label: "Sin respuesta", detail: "0 respuestas", tone: "neutral", token: "interest-0" };
}

function nextActionFor(conversation) {
  if (conversation.handoff) return { label: "Responder manual", tone: "warn" };
  if (conversation.paid && !conversation.productLinkSent) return { label: "Enviar acceso", tone: "danger" };
  if (conversation.paid) return { label: "Cliente completo", tone: "good" };
  if (conversation.promoSent || conversation.productLinkSent) return { label: "Esperando pago", tone: "soft" };
  if (conversation.reminderScheduledAt) return { label: "Recordatorio 23h", tone: "soft" };
  return { label: "Bot trabajando", tone: "neutral" };
}

function conversationSearchText(conversation, extra = []) {
  return [
    conversation.phoneNumber,
    conversation.name,
    conversation.channel,
    conversation.displayHandle,
    conversation.externalId,
    conversation.lastMessage,
    conversation.latestPaymentProduct,
    conversation.paid ? "cliente pago convertido venta" : "sin pago pendiente",
    conversation.handoff ? "revision humana pausado" : "bot activo",
    conversation.productLinkSent ? "acceso enviado liberado" : "acceso pendiente",
    conversation.promoSent ? "producto liberado" : "sin liberacion",
    conversation.reminderScheduledAt ? "recordatorio 23h programado" : "sin recordatorio",
    `${conversation.leadReplyCount ?? 0} respuestas lead interes`,
    leadInterest(conversation).label,
    ...extra,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .replace(/"/g, "&quot;");
}

function conversationFilterTokens(conversation) {
  const tokens = ["all"];
  const activityDay = localDateKey(conversation.updatedAt || conversation.createdAt);
  const today = localDateKey();
  const yesterday = shiftDateKey(today, -1);
  const beforeYesterday = shiftDateKey(today, -2);

  if (conversation.handoff) tokens.push("handoff");
  if (conversation.channel === "instagram") tokens.push("instagram");
  else if (conversation.channel === "facebook") tokens.push("facebook");
  else tokens.push("whatsapp");
  if (!conversation.handoff && !conversation.paid) tokens.push("bot");
  if (conversation.promoSent || conversation.productLinkSent) tokens.push("released");
  if (!conversation.productLinkSent) tokens.push("access-pending");
  if (!conversation.paid) tokens.push("unpaid");
  tokens.push(leadInterest(conversation).token);
  if (activityDay === today) tokens.push("today");
  else if (activityDay === yesterday) tokens.push("yesterday");
  else if (activityDay === beforeYesterday) tokens.push("before-yesterday");
  else tokens.push("older");

  return tokens.join(" ");
}

function renderPaymentActions(req, phoneNumber, section, conversation) {
  const encodedPhone = encodeURIComponent(phoneNumber);
  const paymentFields = adminHiddenFields(req, { section, productCode: "fantasia" });
  const isPaid = conversation && conversation.paid === 1;
  const promoAlreadySent = conversation && conversation.promoSent === 1;

  if (isPaid) {
    return `<div class="quick-actions"><form method="post" action="/admin/contacts/${encodedPhone}/revert-conversion" onsubmit="return confirm('¿Revertir esta conversión? Se quitará el último ingreso de los reportes.')">${adminHiddenFields(req, { section })}<button type="submit" class="ghost danger">Revertir conversión</button></form></div>`;
  }

  return `<div class="quick-actions">
    ${!promoAlreadySent ? `<form method="post" action="/admin/contacts/${encodedPhone}/offer-flash">${adminHiddenFields(req, { section })}<button type="submit" class="bomb">Oferta Fantasía</button></form>` : ""}
    <form method="post" action="/admin/contacts/${encodedPhone}/paid">${paymentFields}<button type="submit">${formatMoneyShort(PAYMENT_PRODUCTS.fantasia.amount)}</button></form>
    <form method="post" action="/admin/contacts/${encodedPhone}/trigger-flow">${adminHiddenFields(req, { section })}<button type="submit" class="secondary">Iniciar flujo</button></form>
    <form method="post" action="/admin/contacts/${encodedPhone}/delete" onsubmit="return confirm('Eliminar esta conversacion y todos sus datos? Esta accion no se puede deshacer.')">${adminHiddenFields(req, { section })}<button type="submit" class="ghost danger">Eliminar</button></form>
  </div>`;
}

function renderConversationTable(req, conversations, options = {}) {
  const section = options.section ?? "conversations";
  const rows = (options.limit ? conversations.slice(0, options.limit) : conversations)
    .map((conversation) => {
      const cleanPhone = conversation.phoneNumber.replace(/[^0-9]/g, "");
      const waUrl = `https://wa.me/${cleanPhone}`;
      const desktopWaUrl = `whatsapp://send?phone=${cleanPhone}`;
      const isInstagram = conversation.channel === "instagram";
      const isFacebook = conversation.channel === "facebook";
      const isSocialDm = isInstagram || isFacebook;
      const displayName = contactDisplayName(conversation);
      const nextAction = nextActionFor(conversation);
      const paymentDetail = conversation.paymentCount
        ? `${formatMoney(conversation.paymentTotal)} · ${escapeHtml(conversation.latestPaymentProduct ?? "Ingreso registrado")}`
        : "Sin ingresos registrados";
      const deliveryDetail = conversation.productLinkSent
        ? `Acceso enviado${conversation.productLinkSentAt ? ` · ${formatDateTime(conversation.productLinkSentAt)}` : ""}`
        : "Acceso pendiente";
      const promoDetail = conversation.paid
          ? "Comprador: recordatorio pausado"
        : conversation.promoSent
          ? `Producto liberado${conversation.promoSentAt ? ` · ${formatDateTime(conversation.promoSentAt)}` : ""}`
          : conversation.reminderScheduledAt
            ? `Recordatorio 23h · ${formatDateTime(conversation.reminderScheduledAt)}`
            : conversation.reminderSentAt
              ? `Recordatorio enviado · ${formatDateTime(conversation.reminderSentAt)}`
              : "Sin recordatorio programado";
      const adDetail = conversation.ctwaSourceId
        ? `Anuncio: ${conversation.ctwaHeadline || conversation.ctwaSourceId}`
        : "Sin anuncio atribuido";
      const filterTokens = conversationFilterTokens(conversation);
      const interest = leadInterest(conversation);
      const searchText = conversationSearchText(conversation, [paymentDetail, deliveryDetail, promoDetail, adDetail, nextAction.label]);

      return `<tr class="conversation-row" data-search="${escapeHtml(searchText)}" data-filter="${escapeHtml(filterTokens)}">
        <td>
          <div class="contact-cell">
            ${isSocialDm && conversation.conversationUrl
              ? `<a href="${escapeHtml(conversation.conversationUrl)}" target="_blank" rel="noopener" class="contact-link">${escapeHtml(displayName)}</a>`
              : isSocialDm
                ? `<strong class="contact-link">${escapeHtml(displayName)}</strong>`
                : `<a href="${waUrl}" target="_blank" rel="noopener" class="contact-link">${conversation.name ? `${escapeHtml(conversation.name)} <small style="color:var(--soft)">${escapeHtml(conversation.phoneNumber)}</small>` : escapeHtml(conversation.phoneNumber)}</a>`}
            <small>${channelBadge(conversation)} ${isSocialDm ? escapeHtml(conversation.phoneNumber) : ""}</small>
            <small>${conversation.messageCount} mensajes · creado ${formatDateTime(conversation.createdAt)}</small>
            <small>${conversation.ctwaSourceId ? `<a href="${escapeHtml(conversation.ctwaSourceUrl || "#")}" target="_blank" rel="noopener" class="inline-action">${escapeHtml(adDetail)}</a>` : escapeHtml(adDetail)}</small>
            <small><span class="interest-dot interest-${interest.tone}"></span>${escapeHtml(interest.label)} · ${escapeHtml(interest.detail)}</small>
            ${isSocialDm ? "" : `<small><a href="${desktopWaUrl}" class="inline-action">WhatsApp App</a> · <a href="${waUrl}" target="_blank" rel="noopener" class="inline-action">WhatsApp Web</a></small>`}
          </div>
        </td>
        <td><span class="badge badge-${nextAction.tone}">${escapeHtml(nextAction.label)}</span><small>${formatRelativeTime(conversation.updatedAt)}</small></td>
        <td><p class="message-preview">${escapeHtml(conversation.lastMessage || "Sin mensajes todavia")}</p></td>
        <td>
          ${statusBadge(conversation, req)}
          <small>${paymentDetail}</small>
          <small>${deliveryDetail}</small>
          <small>${promoDetail}</small>
        </td>
        <td><span class="date-pill">${formatDateTime(conversation.updatedAt)}</span></td>
        <td>${renderPaymentActions(req, conversation.phoneNumber, section, conversation)}</td>
      </tr>`;
    })
    .join("");

  return conversations.length
    ? `<div class="table-shell"><table class="conversation-table"><thead><tr><th>Contacto</th><th>Proxima accion</th><th>Ultimo mensaje</th><th>Estado comercial</th><th>Actividad</th><th>Acciones rapidas</th></tr></thead><tbody>${rows}</tbody></table></div>`
    : `<div class="empty">Todavia no hay conversaciones registradas en memoria.</div>`;
}

function renderConversationSection(req, conversations, options = {}) {
  const convFilter = options.convFilter ?? "all";
  const quickFilter = options.quickFilter ?? "all";
  const section = options.section ?? "conversations";
  const search = String(options.search ?? "");
  const total = Math.max(conversations.length, Number(options.total) || 0);
  const page = Math.max(1, Number(options.page) || 1);
  const pageSize = Math.max(1, Number(options.pageSize) || conversations.length || 1);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const filterUrl = (f) => `${adminSectionPath(req, "conversations", { convFilter: f, quickFilter, q: search, page: 1 })}`;
  const quickFilterUrl = (filter) => adminSectionPath(req, "conversations", { convFilter, quickFilter: filter, q: search, page: 1 });
  const filterPills = `<div class="filter-pills">
    <a class="${convFilter === "all" ? "active" : ""}" href="${filterUrl("all")}">Todas</a>
    <a class="${convFilter === "interested" ? "active" : ""}" href="${filterUrl("interested")}">Interesados</a>
    <a class="${convFilter === "converted" ? "active" : ""}" href="${filterUrl("converted")}">Convirtieron</a>
    <a class="${convFilter === "pending" ? "active" : ""}" href="${filterUrl("pending")}">Pendientes</a>
  </div>`;
  const tableHtml = renderConversationTable(req, conversations, { ...options, convFilter });
  const historyActions = `<div class="history-actions">
    <form method="get" action="/admin/contacts.csv">
      ${adminHiddenFields(req)}
      <button type="submit" class="secondary">Descargar teléfonos CSV</button>
    </form>
    <form method="post" action="/admin/contacts/purge" onsubmit="return confirm('Esta acción elimina contactos, mensajes y pagos del historial. No se puede deshacer. ¿Continuar?')">
      ${adminHiddenFields(req, { section: "conversations" })}
      <label><span>Para borrar, escribí BORRAR TODO</span><input name="confirmation" required autocomplete="off" placeholder="BORRAR TODO"></label>
      <button type="submit" class="ghost danger">Borrar todo el histórico</button>
    </form>
  </div>`;
  const pagination = pageCount > 1 ? `<nav class="filter-pills" aria-label="Paginacion de conversaciones">
    ${page > 1 ? `<a href="${adminSectionPath(req, "conversations", { convFilter, quickFilter, q: search, page: page - 1 })}">Anterior</a>` : ""}
    <span>Pagina ${page} de ${pageCount}</span>
    ${page < pageCount ? `<a href="${adminSectionPath(req, "conversations", { convFilter, quickFilter, q: search, page: page + 1 })}">Siguiente</a>` : ""}
  </nav>` : "";

  return `<section class="panel conversation-panel management-panel">
    <div class="panel-header conversation-header">
      <div>
        <span class="eyebrow">Gestion comercial</span>
        <h2>Conversaciones</h2>
        <small class="conversation-counter" data-total="${total}">Mostrando ${conversations.length} de ${total}</small>
      </div>
      ${filterPills}
    </div>
    ${historyActions}
    <div class="conversation-toolbar management-toolbar">
      <form method="get" action="/admin" class="search-box">
        ${adminHiddenFields(req, { section, convFilter, quickFilter })}
        <label><span>Buscar en todas</span><input name="q" value="${escapeHtml(search)}" placeholder="Numero, palabra, estado o mensaje"></label>
        <button type="submit" class="secondary">Buscar</button>
      </form>
      <div class="quick-filter-pills" role="group" aria-label="Filtros rapidos">
        ${[["all", "Todo"], ["today", "Hoy"], ["yesterday", "Ayer"], ["before-yesterday", "Anteayer"], ["interest-1", "1 respuesta"], ["interest-2", "2 respuestas"], ["interest-3plus", "3+ respuestas"], ["instagram", "Instagram"], ["facebook", "Facebook"], ["whatsapp", "WhatsApp"], ["handoff", "Revision"], ["bot", "Bot activo"], ["released", "Liberados"], ["access-pending", "Acceso pendiente"], ["unpaid", "Sin pago"]].map(([value, label]) => `<a class="${quickFilter === value ? "active" : ""}" href="${quickFilterUrl(value)}">${label}</a>`).join("")}
      </div>
    </div>
    ${tableHtml}
    <div class="empty table-empty" hidden>No hay conversaciones que coincidan con la busqueda.</div>
    ${pagination}
  </section>`;
}

function renderRecentConversationRail(req, conversations) {
  const cards = conversations.slice(0, 5).map((conversation, index) => {
    const cleanPhone = conversation.phoneNumber.replace(/[^0-9]/g, "");
    const waUrl = `https://wa.me/${cleanPhone}`;
    const isInstagram = conversation.channel === "instagram";
    const isFacebook = conversation.channel === "facebook";
    const isSocialDm = isInstagram || isFacebook;
    const displayName = contactDisplayName(conversation);
    const nextAction = nextActionFor(conversation);
    const interest = leadInterest(conversation);
    const isConversion = conversation.paid === 1 || Number(conversation.paymentCount) > 0;
    const conversionAt = conversation.latestPaymentAt || conversation.paidAt;
    const contactLink = isSocialDm && conversation.conversationUrl
      ? `<a href="${escapeHtml(conversation.conversationUrl)}" target="_blank" rel="noopener" class="contact-link">${escapeHtml(displayName)}</a>`
      : isSocialDm
        ? `<strong class="contact-link">${escapeHtml(displayName)}</strong>`
        : `<a href="${waUrl}" target="_blank" rel="noopener" class="contact-link">${conversation.name ? escapeHtml(conversation.name) : escapeHtml(conversation.phoneNumber)}</a>`;
    const commercialDetail = conversation.paymentCount
      ? `${formatMoney(conversation.paymentTotal)} registrado`
      : conversation.productLinkSent
        ? "Acceso enviado"
        : conversation.promoSent
          ? "Producto liberado"
          : "Sin pago";

    return `<article class="recent-card${isConversion ? " recent-card-conversion" : ""}" style="--card-index:${index}">
      <div class="recent-card-top">
        <div>${contactLink}<small>${channelBadge(conversation)} ${isSocialDm ? escapeHtml(conversation.phoneNumber) : ""}</small></div>
        <div class="recent-card-badges">${isConversion ? `<span class="conversion-badge">Conversión</span>` : ""}<span class="badge badge-${nextAction.tone}">${escapeHtml(nextAction.label)}</span></div>
      </div>
      <p class="message-preview">${escapeHtml(conversation.lastMessage || "Sin mensajes todavia")}</p>
      <div class="recent-card-meta">
        <span><i class="interest-dot interest-${interest.tone}"></i>${escapeHtml(interest.label)}</span>
        <span>${escapeHtml(commercialDetail)}</span>
        <span>${isConversion && conversionAt ? `Pagó ${formatRelativeTime(conversionAt)}` : formatRelativeTime(conversation.updatedAt)}</span>
      </div>
      ${renderPaymentActions(req, conversation.phoneNumber, "dashboard", conversation)}
    </article>`;
  }).join("");

  return `<aside class="recent-rail" aria-label="Ultimas conversiones y conversaciones">
    <div class="recent-rail-header">
      <div>
        <span class="eyebrow">Atencion ahora</span>
        <h2>Conversiones y actividad reciente</h2>
        <small>Las últimas conversiones aparecen primero, sin filtrar por fecha.</small>
      </div>
      <a class="badge badge-neutral" href="${adminSectionPath(req, "conversations")}">Ver todas</a>
    </div>
    ${cards || `<div class="empty">Todavía no hay conversaciones registradas.</div>`}
  </aside>`;
}

function renderPaymentsTable(payments) {
  const rows = payments
    .map(
      (payment) => `<tr>
        <td><span class="date-pill">${formatDateTime(payment.paidAt)}</span></td>
        <td><strong>${escapeHtml(payment.phoneNumber)}</strong><small>${escapeHtml(payment.productCode)}</small></td>
        <td>${escapeHtml(payment.productName)}</td>
        <td class="money">${formatMoney(payment.amount)}</td>
        <td class="money muted-money">${payment.discount ? formatMoney(payment.discount) : "-"}</td>
        <td>${escapeHtml(payment.note || "Sin nota")}</td>
      </tr>`
    )
    .join("");

  return payments.length
    ? `<div class="table-shell"><table><thead><tr><th>Fecha</th><th>Contacto</th><th>Producto</th><th>Ingreso</th><th>Descuento</th><th>Nota</th></tr></thead><tbody>${rows}</tbody></table></div>`
    : `<div class="empty">No hay pagos para el rango seleccionado.</div>`;
}

function buildAdsDecision(metrics) {
  if (metrics.adSpend <= 0) {
    return {
      tone: "neutral",
      title: "Cargá inversión",
      text: "Sumá el gasto en anuncios del día para calcular ROAS, CPA y ganancia real.",
    };
  }

  if (metrics.sales === 0) {
    return {
      tone: "danger",
      title: "Revisar campaña",
      text: "Hay inversión cargada pero todavía no entraron ventas. Mirá creativos, segmentación y calidad de chats.",
    };
  }

  if (metrics.roas >= 2 && metrics.profit > 0) {
    return {
      tone: "good",
      title: "Escalar con control",
      text: "El día está rentable. Podés subir presupuesto de forma gradual mientras CPA y conversión se mantengan.",
    };
  }

  if (metrics.roas >= 1) {
    return {
      tone: "warn",
      title: "Cuidar presupuesto",
      text: "La campaña recupera inversión, pero el margen es ajustado. Conviene mejorar cierre o bajar costo por chat.",
    };
  }

  return {
    tone: "danger",
    title: "Pausar o corregir",
    text: "El gasto supera la facturación del día. Revisá anuncio, oferta, seguimiento y velocidad de respuesta.",
  };
}

function renderKpiCard(label, value, detail, tone = "") {
  return `<article class="metric-card kpi-card ${tone ? `kpi-${tone}` : ""}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><p>${escapeHtml(detail)}</p></article>`;
}

function renderHeroKpiCard(label, value, detail, tone = "", accent = "") {
  return `<article class="hero-kpi ${tone ? `hero-${tone}` : ""} ${accent ? `hero-accent-${accent}` : ""}">
    <span>${escapeHtml(label)}</span>
    <strong>${escapeHtml(value)}</strong>
    <p>${escapeHtml(detail)}</p>
  </article>`;
}

function interactionDiagnostic(metrics) {
  if (metrics.chats === 0) {
    return { tone: "neutral", title: "Sin volumen todavia", text: "Cuando entren chats del día vas a ver si el anuncio trae curiosos o conversaciones reales." };
  }

  if (metrics.adSpend > 0 && metrics.cpl > 0 && metrics.cpl > 1500) {
    return { tone: "danger", title: "Costo por chat alto", text: "La campaña está comprando conversaciones caras. Revisá creativo, segmentación o promesa inicial." };
  }

  if (metrics.interactionRate < 15 && metrics.chats >= 5) {
    return { tone: "danger", title: "Poca respuesta real", text: "Entran chats pero pocos responden más de una vez. Revisá anuncio, expectativa y primer mensaje." };
  }

  if (metrics.interested > 0 && metrics.sales === 0) {
    return { tone: "warn", title: "Hay interés, falta cierre", text: "La gente conversa pero no compra. Mirá objeciones, timing del alias y seguimiento manual." };
  }

  if (metrics.hot > 0 && metrics.conversionRate < 8) {
    return { tone: "warn", title: "Interesados sin convertir", text: "Los 3+ mensajes muestran intención. Conviene priorizarlos en atención y cierre." };
  }

  if (metrics.roas >= 2 && metrics.sales > 0) {
    return { tone: "good", title: "Calidad saludable", text: "El día trae conversaciones con intención y ventas. Se puede escalar con control." };
  }

  return { tone: "neutral", title: "Mirá la calidad", text: "Usá la mezcla de 1, 2 y 3+ respuestas para decidir si el problema es anuncio o cierre." };
}

function renderInteractionChart(metrics) {
  const total = Math.max(metrics.chats, 1);
  const subtitle = metrics.source || "Respuestas en chats atribuidos del CRM";
  const rows = [
    { label: "1 respuesta", value: metrics.oneReply, className: "one", help: "curiosidad inicial" },
    { label: "2 respuestas", value: metrics.twoReplies, className: "two", help: "interés activo" },
    { label: "3+ respuestas", value: metrics.threePlusReplies, className: "three", help: "prioridad de cierre" },
  ];
  const diagnostic = interactionDiagnostic(metrics);
  const bars = rows
    .map((row) => {
      const percent = (row.value / total) * 100;
      const width = metrics.chats ? Math.max(4, Math.round(percent)) : 0;
      return `<div class="interaction-row">
        <div class="interaction-label"><strong>${escapeHtml(row.label)}</strong><small>${escapeHtml(row.help)}</small></div>
        <div class="interaction-track"><div class="interaction-fill ${row.className}" style="width:${width}%"></div></div>
        <div class="interaction-value"><strong>${row.value}</strong><small>${formatPercent(percent)}</small></div>
      </div>`;
    })
    .join("");

  return `<section class="panel interaction-panel">
    <div class="panel-header"><div><h2>Calidad de conversaciones</h2><small>${escapeHtml(subtitle)}</small></div><span class="badge badge-${diagnostic.tone}">${metrics.interested} interesados</span></div>
    <div class="interaction-chart">${bars}</div>
    <div class="interaction-diagnostic diagnostic-${diagnostic.tone}">
      <strong>${escapeHtml(diagnostic.title)}</strong>
      <p>${escapeHtml(diagnostic.text)}</p>
    </div>
  </section>`;
}

function performanceTone(day) {
  if (day.adSpend <= 0) return day.revenue > 0 ? "good" : "neutral";

  const margin = day.profit / day.adSpend;
  if (margin > 0.05) return "good";
  if (margin >= -0.05) return "warn";
  return "danger";
}

function renderDayPerformanceChips(req, days, activeDate, section = "dashboard", options = {}) {
  return `<div class="day-performance-strip">${days
    .map((day) => {
      const tone = performanceTone(day);
      const label = parseDateKey(day.date).toLocaleDateString("es-AR", { weekday: "short", day: "2-digit" });
      const roas = day.adSpend > 0 ? day.revenue / day.adSpend : Number.NaN;
      const href = section === "dashboard"
        ? adminSectionPath(req, "dashboard", { date: day.date })
        : adminSectionPath(req, "income", { from: day.date, to: day.date });

      return `<a href="${href}" class="day-chip day-${tone} ${day.date === activeDate ? "active" : ""}">
        <span>${escapeHtml(label)}</span>
        <strong>${formatMoney(day.profit)}</strong>
        ${options.showRoas ? `<small>ROAS ${escapeHtml(formatMultiple(roas))}</small>` : ""}
      </a>`;
    })
    .join("")}</div>`;
}

function renderRevenueCorrectionCard(req, metrics) {
  const tone = metrics.adjustment.amount ? "warn" : "good";
  const adjustmentDetail = metrics.adjustment.amount
    ? `Sistema ${formatMoney(metrics.systemRevenue)} · Ajuste ${formatSignedMoney(metrics.adjustment.amount)}`
    : `${metrics.sales} ventas registradas`;

  return `<article class="metric-card kpi-card kpi-${tone} revenue-card">
    <button class="revenue-edit-toggle" type="button" title="Corregir facturacion">✎</button>
    <span>Facturacion</span>
    <strong>${formatMoney(metrics.revenue)}</strong>
    <p>${escapeHtml(adjustmentDetail)}</p>
    ${metrics.adjustment.amount ? `<small class="adjustment-note">Corregida: ${escapeHtml(metrics.adjustment.note || "sin motivo")}</small>` : ""}
    <form method="post" action="/admin/revenue-adjustment" class="revenue-adjust-form">
      ${adminHiddenFields(req, { section: "dashboard", date: metrics.date })}
      <strong>Corregir facturacion</strong>
      <small>Sistema: ${formatMoney(metrics.systemRevenue)} · Total actual: ${formatMoney(metrics.revenue)}</small>
      <label>Ajuste neto<input name="amount" inputmode="numeric" value="${escapeHtml(metrics.adjustment.amount || "")}" placeholder="Ej: -16999 o 16999"></label>
      <label>Motivo<input name="note" value="${escapeHtml(metrics.adjustment.note ?? "")}" required placeholder="Ej: pago duplicado"></label>
      <label class="confirm-line"><input type="checkbox" name="confirm" value="yes" required style="width:auto"> Confirmo que corrige un error</label>
      <label>Escribir AJUSTAR<input name="phrase" autocomplete="off" placeholder="AJUSTAR" pattern="AJUSTAR" required></label>
      <button type="submit" class="secondary">Guardar ajuste</button>
    </form>
  </article>`;
}

function renderAdsChart(metrics) {
  const adSpend = Math.max(0, Number(metrics.adSpend) || 0);
  const revenue = Math.max(0, Number(metrics.revenue) || 0);
  const profit = Number(metrics.profit) || 0;
  const isProfitable = profit >= 0;
  const recovered = adSpend ? Math.min(adSpend, revenue) : 0;
  const secondValue = adSpend ? (isProfitable ? Math.max(0, profit) : Math.max(0, adSpend - recovered)) : revenue;
  const total = Math.max(adSpend ? (isProfitable ? recovered + secondValue : adSpend) : revenue, 1);
  const recoveredWidth = Math.max(recovered > 0 ? 4 : 0, (recovered / total) * 100);
  const secondWidth = Math.max(secondValue > 0 ? 4 : 0, (secondValue / total) * 100);
  const resultLabel = isProfitable ? "Ganancia" : "Perdida";
  const resultClass = isProfitable ? "profit" : "loss";

  return `<section class="panel ads-chart-panel">
    <div class="panel-header"><div><h2>Inversion vs resultado</h2><small>Lectura rapida del dia seleccionado</small></div><span class="badge badge-${metrics.profit >= 0 ? "good" : "danger"}">${metrics.profit >= 0 ? "Rentable" : "En perdida"}</span></div>
    <div class="ads-chart">
      <div class="ads-stacked-label"><strong>Resultado sobre inversion</strong><span>${formatMoney(total)}</span></div>
      <div class="ads-stacked-bar" aria-label="Resultado sobre inversion">
        <div class="ads-stacked-segment recovered" style="width:${recoveredWidth}%"></div>
        <div class="ads-stacked-segment ${resultClass}" style="width:${secondWidth}%"></div>
      </div>
      <div class="ads-result-summary">
        <span><i class="recovered"></i>Costo recuperado <strong>${formatMoney(recovered)}</strong></span>
        <span><i class="${resultClass}"></i>${resultLabel} <strong>${formatMoney(secondValue)}</strong></span>
        <span>Facturacion <strong>${formatMoney(revenue)}</strong></span>
      </div>
    </div>
  </section>`;
}

function renderAdsPresetLink(req, preset, label, activePreset) {
  const params = { adsPreset: preset };
  if (req.query.adAccountId) params.adAccountId = req.query.adAccountId;
  return `<a class="${preset === activePreset ? "active" : ""}" href="${adminSectionPath(req, "ads", params)}">${escapeHtml(label)}</a>`;
}

function qualitySlices(quality = {}) {
  return [
    { key: "noReply", label: "Sin respuesta", value: quality.noReply ?? 0, color: "#69707d" },
    { key: "oneReply", label: "1 respuesta", value: quality.oneReply ?? 0, color: "#c99a3a" },
    { key: "twoReplies", label: "2 respuestas", value: quality.twoReplies ?? 0, color: "#c9a55a" },
    { key: "threePlus", label: "3+ respuestas", value: quality.threePlus ?? 0, color: "#4a9a5a" },
  ];
}

function donutGradient(slices) {
  const total = Math.max(1, slices.reduce((sum, slice) => sum + slice.value, 0));
  let cursor = 0;
  const stops = slices
    .filter((slice) => slice.value > 0)
    .map((slice) => {
      const start = (cursor / total) * 100;
      cursor += slice.value;
      const end = (cursor / total) * 100;
      return `${slice.color} ${start.toFixed(2)}% ${end.toFixed(2)}%`;
    });
  return stops.length ? `conic-gradient(${stops.join(", ")})` : "conic-gradient(#69707d 0 100%)";
}

function renderQualityDonut(quality = {}) {
  const slices = qualitySlices(quality);
  const total = slices.reduce((sum, slice) => sum + slice.value, 0);
  const legend = slices.map((slice) => `<span><i style="background:${slice.color}"></i>${escapeHtml(slice.label)} <strong>${slice.value}</strong></span>`).join("");

  return `<section class="panel quality-donut-panel">
    <div class="panel-header"><div><h2>Calidad de chats</h2><small>Distribución de conversaciones atribuidas</small></div></div>
    <div class="donut-wrap">
      <div class="quality-donut" style="background:${donutGradient(slices)}"><div class="quality-donut-center"><strong>${total}</strong><small>chats</small></div></div>
      <div class="donut-legend">${legend}</div>
    </div>
  </section>`;
}

function renderQualityMiniChart(quality = {}) {
  const slices = qualitySlices(quality);
  const total = Math.max(1, slices.reduce((sum, slice) => sum + slice.value, 0));
  return `<div class="quality-mini" title="calidad de chats">${slices.map((slice) => `<span style="width:${Math.max(0, (slice.value / total) * 100).toFixed(1)}%;background:${slice.color}"></span>`).join("")}</div><small>${quality.threePlus ?? 0} hot · ${quality.sales ?? 0} ventas</small>`;
}

function renderStatusBadge(label, tone = "neutral") {
  return `<span class="badge badge-${tone}">${escapeHtml(label)}</span>`;
}

function renderAdStatusCell(ad = {}) {
  const status = ad.statusInfo ?? adStatusSummary(ad);
  return `<div class="status-stack">
    ${renderStatusBadge(status.ad, status.tone)}
    <small>Campaña: ${escapeHtml(status.campaign)}</small>
    <small>Adset: ${escapeHtml(status.adSet)}</small>
  </div>`;
}

function renderMonthlyWinners(monthlyAdRows = [], month = {}) {
  const winners = monthlyAdRows
    .filter((ad) => ad.crmSales > 0 || ad.realRoas >= 1 || ad.crmInterested >= 3)
    .slice(0, 5);

  const rows = winners.map((ad, index) => {
    const creative = ad.creative ?? {};
    const imageUrl = creative.thumbnailUrl || creative.imageUrl || (Array.isArray(creative.mediaUrls) ? creative.mediaUrls[0] : "");
    const preview = imageUrl
      ? `<img class="winner-preview-img" src="${escapeHtml(imageUrl)}" loading="lazy" alt="Preview anuncio ganador">`
      : `<div class="winner-preview-empty">sin preview</div>`;

    return `<div class="winner-row">
      ${preview}
      <div>
        <strong>#${index + 1} ${escapeHtml(ad.name ?? "Anuncio")}</strong>
        <span>${formatMultiple(ad.realRoas)} ROAS · ${ad.crmSales} ventas · ${ad.crmInterested} interesados</span>
        <small>${escapeHtml(ad.campaignName ?? "Campaña")} · score ${ad.winnerScore}</small>
      </div>
    </div>`;
  }).join("");

  return `<section class="panel winners-panel">
    <div class="panel-header"><div><h2>Ganadores del período</h2><small>${escapeHtml(month.fromDate ?? "")} a ${escapeHtml(month.toDate ?? "")} · ventas cohorte CRM</small></div></div>
    ${rows ? `<div class="winner-list">${rows}</div>` : `<div class="empty">Todavía no hay ganadores claros en este período.</div>`}
  </section>`;
}

function renderHourlyInsights(hourly = {}) {
  const timeline = hourly.timeline ?? [];
  const rows = timeline.length ? timeline : (hourly.rows ?? []);
  const maxScore = Math.max(...rows.map((row) => Number(row.score) || 0), 1);
  const totalSignals = rows.reduce((total, row) => total + (Number(row.sales) || 0) + (Number(row.replies) || 0), 0);
  const bestStart = hourly.best?.startHour;
  const html = rows.map((row) => {
    const score = Number(row.score) || 0;
    const intensity = Math.max(0, Math.min(1, score / maxScore));
    const heat = Math.round(intensity * 100);
    const isBest = row.startHour === bestStart && score > 0;
    const opacity = (0.08 + intensity * 0.42).toFixed(2);
    const borderOpacity = (0.12 + intensity * 0.5).toFixed(2);
    return `<div class="hour-heat-cell ${isBest ? "best" : ""}" style="--heat:${heat}%;--heat-opacity:${opacity};--heat-border:${borderOpacity}">
      <span>${escapeHtml(row.label)}</span>
      <strong>${row.sales} ventas</strong>
      <small>${row.replies} respuestas · ${formatMoney(row.revenue)}</small>
    </div>`;
  }).join("");
  const bestText = hourly.best
    ? `${hourly.best.label}: ${hourly.best.sales} ventas, ${hourly.best.replies} primeras respuestas, ${formatMoney(hourly.best.revenue)}`
    : "Todavía falta señal para elegir una franja.";

  return `<section class="panel hours-panel">
    <div class="panel-header"><div><h2>Horarios para puja</h2><small>Hora Argentina · señales del período seleccionado · confianza ${escapeHtml(hourly.confidence ?? "baja")}</small></div></div>
    ${html ? `<div class="hour-heatmap">${html}</div>
      <div class="hour-summary">
        <span>Mejor franja</span>
        <strong>${escapeHtml(bestText)}</strong>
        <small>${totalSignals ? `${totalSignals} señales totales en el período` : "Sin actividad suficiente todavía"}</small>
      </div>` : `<div class="empty">Todavía no hay horarios suficientes.</div>`}
  </section>`;
}

function renderAdsRecommendations(recommendations = []) {
  const rows = recommendations.map((text) => `<li>${escapeHtml(text)}</li>`).join("");
  return `<section class="panel recommendation-panel">
    <div class="panel-header"><div><h2>Configuración sugerida</h2><small>Puja, presupuesto y enfoque para subir ROAS</small></div></div>
    <ul class="recommendation-list">${rows}</ul>
  </section>`;
}

function renderAdsDetailPanel(adsDashboard, options = {}) {
  const title = options.title ?? "Anuncios: qué rinde y qué no";
  const subtitle = options.subtitle ?? "ROAS por cohorte: ventas cobradas hasta hoy de leads iniciados en el período seleccionado";
  const limit = options.limit ?? 30;
  const adRows = (adsDashboard?.adRows ?? []).slice(0, limit).map((ad) => {
    const currency = ad.currency ?? "";
    const creative = ad.creative ?? {};
    const imageUrl = creative.thumbnailUrl || creative.imageUrl || (Array.isArray(creative.mediaUrls) ? creative.mediaUrls[0] : "");
    const preview = imageUrl
      ? `<img class="ad-preview-img" src="${escapeHtml(imageUrl)}" loading="lazy" alt="Preview anuncio">`
      : `<div class="ad-preview-empty">sin preview</div>`;
    const creativeText = String(creative.body ?? "").slice(0, 130);
    const alert = ad.alert ?? { tone: "neutral", label: "Monitorear" };

    return `<tr>
      <td>${preview}</td>
      <td><strong>${escapeHtml(ad.name ?? "Anuncio")}</strong><small>${escapeHtml(ad.campaignName ?? "")} · ${escapeHtml(ad.platformAdId ?? "")}</small>${creativeText ? `<p class="message-preview">${escapeHtml(creativeText)}</p>` : ""}${creative.instagramPermalinkUrl ? `<a class="inline-action" href="${escapeHtml(creative.instagramPermalinkUrl)}" target="_blank" rel="noreferrer">ver post</a>` : ""}</td>
      <td>${renderAdStatusCell(ad)}</td>
      <td class="money">${formatAdMoney(ad.spend, currency)}</td>
      <td>${ad.metaConversations}<small>${ad.crmChats} CRM · ${ad.crmChats ? `${formatAdMoney(ad.spend / ad.crmChats, currency)} / CRM` : "sin CRM"}</small></td>
      <td>${renderQualityMiniChart(ad.quality)}</td>
      <td>${ad.crmSales}<small>${formatMoney(ad.crmRevenue)} cohorte</small></td>
      <td>${formatMultiple(ad.realRoas)}</td>
      <td><span class="badge badge-${alert.tone}">${escapeHtml(alert.label)}</span><small>score ${ad.winnerScore}</small></td>
      <td><small>${escapeHtml(ad.bidRecommendation)}</small></td>
    </tr>`;
  }).join("");

  return `<section class="panel ads-detail-panel ${options.compact ? "dashboard-ads-detail" : ""}">
    <div class="panel-header"><div><h2>${escapeHtml(title)}</h2><small>${escapeHtml(subtitle)}</small></div>${options.actionHtml ?? ""}</div>
    ${adRows ? `<div class="table-shell ads-detail-table"><table><thead><tr><th>Preview</th><th>Anuncio</th><th>Estado</th><th>Gasto</th><th>Chats iniciados</th><th>Calidad</th><th>Ventas cohorte</th><th>ROAS cohorte</th><th>Alerta</th><th>Puja sugerida</th></tr></thead><tbody>${adRows}</tbody></table></div>` : `<div class="empty">No hay anuncios para mostrar.</div>`}
  </section>`;
}

function renderAdsDashboard(req, adsDashboard) {
  if (!adsDashboard) return `<section class="view" id="ads"><section class="panel"><div class="empty">Todavía no se cargaron métricas de Meta Ads.</div></section></section>`;

  const adAccounts = adsDashboard.adAccounts ?? [];
  const options = adAccounts.map((account) => {
    const selected = account.id === adsDashboard.selectedAdAccountId ? " selected" : "";
    return `<option value="${escapeHtml(account.id)}"${selected}>${escapeHtml(account.name || account.id)} · ${escapeHtml(account.currency || "-")}</option>`;
  }).join("");
  const nativeCurrency = adAccounts[0]?.currency || "USD";
  const nativeSpend = (adsDashboard.adRows ?? []).reduce((total, ad) => total + (Number(ad.spend) || 0), 0);
  const spendArs = (adsDashboard.adRows ?? []).reduce((total, ad) => total + (Number(ad.spendArs) || 0), 0);
  const crmChats = (adsDashboard.adRows ?? []).reduce((total, ad) => total + (Number(ad.crmChats) || 0), 0);
  const metaChats = (adsDashboard.adRows ?? []).reduce((total, ad) => total + (Number(ad.metaConversations) || 0), 0);
  const crmSales = (adsDashboard.adRows ?? []).reduce((total, ad) => total + (Number(ad.crmSales) || 0), 0);
  const crmRevenue = (adsDashboard.adRows ?? []).reduce((total, ad) => total + (Number(ad.crmRevenue) || 0), 0);
  const paidPeriodAttributedSales = (adsDashboard.paidPeriodAttributedPayments ?? []).length;
  const pendingAttributionSales = (adsDashboard.pendingAttributionPayments ?? []).length;
  const unassignedAttributionSales = (adsDashboard.unassignedAttributionPayments ?? []).length;
  const alertCount = (adsDashboard.adRows ?? []).filter((ad) => ["danger", "warn"].includes(ad.alert?.tone)).length;
  const nativeCostPerChat = crmChats ? nativeSpend / crmChats : 0;
  const nativeCostPerMetaChat = metaChats ? nativeSpend / metaChats : 0;
  const costPerMetaChatArs = metaChats ? spendArs / metaChats : 0;
  const realRoas = spendArs ? crmRevenue / spendArs : 0;
  const quality = sumQualityCounts(adsDashboard.adRows ?? []);
  const channelSummary = (adsDashboard.attributedPayments ?? []).reduce((summary, payment) => {
    const channel = payment.channel === "instagram" ? "IG" : payment.channel === "facebook" ? "FB" : "WA";
    summary[channel] = (summary[channel] ?? 0) + 1;
    return summary;
  }, {});
  const channelText = Object.entries(channelSummary).map(([channel, count]) => `${channel} ${count}`).join(" · ") || "sin ventas Ads atribuidas";
  return `<section class="view" id="ads">
    <section class="panel ads-hero">
      <div>
        <span class="eyebrow">Meta Ads</span>
        <h1>Rendimiento de anuncios</h1>
        <small>${escapeHtml(adsDashboard.presetLabel || "Hoy")} · cuenta por defecto Ofiprof${adsDashboard.error ? ` · Error: ${escapeHtml(adsDashboard.error)}` : ""}</small>
      </div>
      <form method="get" action="/admin" class="income-calendar">
        ${adminHiddenFields(req, { section: "ads", adsPreset: adsDashboard.preset })}
        <label>Cuenta Ads<select disabled>${options}</select></label>
        <button class="secondary" type="submit">Actualizar</button>
      </form>
      <div class="range-shortcuts ads-presets">
        ${renderAdsPresetLink(req, "today", "Hoy", adsDashboard.preset)}
        ${renderAdsPresetLink(req, "yesterday", "Ayer", adsDashboard.preset)}
        ${renderAdsPresetLink(req, "7d", "7 días", adsDashboard.preset)}
        ${renderAdsPresetLink(req, "15d", "15 días", adsDashboard.preset)}
        ${renderAdsPresetLink(req, "30d", "30 días", adsDashboard.preset)}
      </div>
    </section>
    <div class="hero-kpi-grid ads-currency-grid">
      ${renderHeroKpiCard("Gasto", formatAdMoney(nativeSpend, nativeCurrency), `${metaChats} chats Meta · ${crmChats} CRM atribuidos`, nativeSpend ? "warn" : "", "roas")}
      ${renderHeroKpiCard("Costo por chat", metaChats ? formatAdMoney(nativeCostPerMetaChat, nativeCurrency) : crmChats ? formatAdMoney(nativeCostPerChat, nativeCurrency) : "-", metaChats ? "sobre chats oficiales Meta" : "sobre chats CRM atribuidos", costPerMetaChatArs && costPerMetaChatArs < 1800 ? "good" : costPerMetaChatArs ? "warn" : "", "volume")}
      ${renderHeroKpiCard("Ventas Ads cohorte", String(crmSales), `${formatMoney(crmRevenue)} · ${pendingAttributionSales} sin origen CTWA · ${unassignedAttributionSales} fuera de Ofiprof USD`, crmSales ? "good" : "warn", "sales")}
      ${renderHeroKpiCard("ROAS cohorte", formatMultiple(realRoas), `${paidPeriodAttributedSales} ventas Ads cobradas en período · ${alertCount} alertas`, realRoas >= 1 ? "good" : spendArs ? "warn" : "", "interest")}
    </div>
    <section class="quality-insight-grid">
      ${renderQualityDonut(quality)}
      <section class="panel decision-panel decision-${alertCount ? "warn" : "good"}">
        <span>Lectura rápida</span>
        <h2>${alertCount ? "Hay anuncios para revisar" : "Sin alertas críticas"}</h2>
        <p>${escapeHtml(alertCount ? "Priorizá pausar o ajustar los anuncios con gasto, chats caros o baja calidad." : "La distribución de chats no muestra problemas fuertes en este período.")}</p>
      </section>
    </section>
    <section class="ads-insight-grid">
      ${renderMonthlyWinners(adsDashboard.monthlyAdRows ?? [], adsDashboard.monthRange ?? {})}
      ${renderHourlyInsights(adsDashboard.hourlyInsights ?? {})}
      ${renderAdsRecommendations(adsDashboard.recommendations ?? [])}
    </section>
    ${renderAdsDetailPanel(adsDashboard)}
  </section>`;
}

function renderRangeChart(series) {
  const maxValue = Math.max(...series.flatMap((day) => [day.revenue, day.adSpend, Math.abs(day.profit)]), 1);
  const rows = series
    .map((day) => {
      const revenueWidth = Math.max(2, Math.round((day.revenue / maxValue) * 100));
      const spendWidth = Math.max(2, Math.round((day.adSpend / maxValue) * 100));
      const profitWidth = Math.max(2, Math.round((Math.abs(day.profit) / maxValue) * 100));
      const label = parseDateKey(day.date).toLocaleDateString("es-AR", { weekday: "short", day: "2-digit", month: "2-digit" });

      return `<div class="range-day-row">
        <div class="range-day-label"><strong>${escapeHtml(label)}</strong><span>${day.sales} ventas</span></div>
        <div class="range-bars">
          <div class="range-track"><div class="range-fill revenue" style="width:${revenueWidth}%"></div><span>${formatMoney(day.revenue)}</span></div>
          <div class="range-track"><div class="range-fill spend" style="width:${spendWidth}%"></div><span>${formatMoney(day.adSpend)}</span></div>
          <div class="range-track"><div class="range-fill ${day.profit >= 0 ? "profit" : "loss"}" style="width:${profitWidth}%"></div><span>${formatMoney(day.profit)}</span></div>
        </div>
      </div>`;
    })
    .join("");

  return `<section class="panel range-chart-panel">
    <div class="panel-header"><div><h2>Evolucion diaria</h2><small>Facturacion, inversion y ganancia por dia</small></div><div class="chart-legend"><span class="revenue">Facturacion</span><span class="spend">Inversion</span><span class="profit">Ganancia</span></div></div>
    <div class="range-chart">${rows}</div>
  </section>`;
}

function renderAdminPage(req, context = {}) {
  const activeSection = activeAdminSection(req);
  const needs = adminSectionDataNeeds(activeSection);
  const adsDashboard = Object.hasOwn(context, "adsDashboard") ? context.adsDashboard : latestAdsDashboard;
  const selectedDate = localDateKey(parseDateKey(req.query.date ?? localDateKey()));
  const previousDate = shiftDateKey(selectedDate, -1);
  const nextDate = shiftDateKey(selectedDate, 1);
  const todayKey = localDateKey();
  const overview = getAdminRevision(todayKey);
  const handoffs = needs.conversations ? listHumanHandoffs() : [];
  const conversationQuery = adminConversationQuery(req);
  const convFilter = conversationQuery.filter;
  const conversationSearch = conversationQuery.search;
  const quickFilter = conversationQuery.quickFilter;
  const conversationPageSize = 50;
  const requestedConversationPage = Math.max(1, Number.parseInt(req.query.page ?? "1", 10) || 1);
  const conversationTotal = needs.conversations ? countConversationSummaries(conversationQuery) : 0;
  const conversationPageCount = Math.max(1, Math.ceil(conversationTotal / conversationPageSize));
  const conversationPage = Math.min(requestedConversationPage, conversationPageCount);
  const paginatedConversations = needs.conversations ? listConversationSummaries({
    ...conversationQuery,
    limit: conversationPageSize,
    offset: (conversationPage - 1) * conversationPageSize,
  }) : [];
  const rawIncomeFrom = String(req.query.from ?? "");
  const rawIncomeTo = String(req.query.to ?? "");
  const incomeFilters = {
    from: isValidDateKey(rawIncomeFrom) ? rawIncomeFrom : shiftDateKey(todayKey, -6),
    to: isValidDateKey(rawIncomeTo) ? rawIncomeTo : todayKey,
  };
  if (incomeFilters.from > incomeFilters.to) {
    const originalFrom = incomeFilters.from;
    incomeFilters.from = incomeFilters.to;
    incomeFilters.to = originalFrom;
  }
  const dashboardFilters = { from: selectedDate, to: selectedDate };
  const primaryAdAccountId = primaryMetaAdAccountId();
  const payments = needs.dashboard
    ? listPayments(dashboardFilters)
    : needs.income ? listPayments(incomeFilters) : [];
  const selectedPayments = needs.dashboard ? payments : [];
  const adSpend = needs.dashboard ? getAdSpend(selectedDate) : { amount: 0 };
  const metaAdsMetrics = needs.dashboard ? (context.metaAdsMetrics ?? getMetaAdsDailyMetrics(selectedDate, primaryAdAccountId)) : null;
  const revenueAdjustment = needs.dashboard ? getRevenueAdjustment(selectedDate) : { amount: 0 };
  const rangeAdSpendRows = needs.income ? listAdSpendRange(incomeFilters) : [];
  const rangeMetaAdsRows = needs.income ? listMetaAdsDailyMetricsRange({ ...incomeFilters, adAccountId: primaryAdAccountId }) : [];
  const rangeRevenueAdjustmentRows = needs.income ? listRevenueAdjustmentsRange(incomeFilters) : [];
  const settings = needs.settings ? getSettings() : { usd_ars_rate: needs.financial ? getSetting("usd_ars_rate", "1500") : "1500" };
  const usdArsRate = needs.financial ? Math.max(1, parseMoney(settings.usd_ars_rate, 1500)) : 1500;
  const status = String(req.query.status ?? "");
  const ctwaBackfillSummary = ["ctwa_backfill_completed", "ctwa_backfill_partial"].includes(status)
    ? ` Páginas: ${Math.max(0, Number.parseInt(req.query.ctwaPages ?? "0", 10) || 0)} · conversaciones: ${Math.max(0, Number.parseInt(req.query.ctwaConversations ?? "0", 10) || 0)} · atribuciones detectadas: ${Math.max(0, Number.parseInt(req.query.ctwaAttributed ?? "0", 10) || 0)}${Number(req.query.ctwaErrors) ? ` · errores: ${Math.max(0, Number.parseInt(req.query.ctwaErrors, 10) || 0)}` : ""}.`
    : "";
  const statusMessage = `${adminStatusMessage(status)}${ctwaBackfillSummary}`;
  const statusBanner = statusMessage ? `<div class="notice">${escapeHtml(statusMessage)}</div>` : "";
  const dashboardConversationTotal = needs.dashboard ? countConversationSummaries({ createdFrom: selectedDate, createdTo: selectedDate }) : 0;
  const dashboardConversations = needs.dashboard ? listConversationSummaries({ limit: 5, prioritizeConversions: true }) : [];
  const selectedAttributedConversations = needs.dashboard ? listCtwaAttributedConversations(dashboardFilters) : [];
  const selectedCrmChats = selectedAttributedConversations.length;
  const selectedMetaChats = metaMessagingConversationCount(metaAdsMetrics);
  const selectedFallbackChats = dashboardConversationTotal;
  const selectedChats = selectedMetaChats || selectedCrmChats || selectedFallbackChats;
  const selectedChatsSource = selectedMetaChats ? "Meta Ads" : selectedCrmChats ? "CRM atribuido" : "CRM deduplicado";
  const selectedQuality = conversationQualityCounts(selectedAttributedConversations);
  const selectedOneReplyChats = selectedQuality.oneReply;
  const selectedTwoReplyChats = selectedQuality.twoReplies;
  const selectedHotChats = selectedQuality.threePlus;
  const selectedInterestedChats = selectedTwoReplyChats + selectedHotChats;
  const selectedSales = selectedPayments.length;
  const selectedSystemRevenue = sumMoney(selectedPayments);
  const selectedRevenue = Math.max(0, selectedSystemRevenue + (Number(revenueAdjustment.amount) || 0));
  const selectedManualAdSpend = Number(adSpend.amount) || 0;
  const selectedMetaAdsUnavailable = Boolean(metaAdsMetrics?.isUnavailable);
  const selectedAdSpend = effectiveAdSpend(selectedManualAdSpend, metaAdsMetrics, usdArsRate);
  const selectedSpendSource = effectiveSpendSource(selectedManualAdSpend, metaAdsMetrics);
  const selectedAdSpendLabel = selectedMetaAdsUnavailable && !selectedManualAdSpend
    ? "Sin datos"
    : !selectedMetaAdsUnavailable && Number(metaAdsMetrics?.spend) > 0
      ? formatAdMoney(metaAdsMetrics.spend, metaAdsMetrics.currency || cachedPrimaryAdAccountCurrency)
      : formatMoney(selectedAdSpend);
  const selectedAdSpendDetail = !selectedMetaAdsUnavailable && Number(metaAdsMetrics?.spend) > 0
    ? `${metaAdsMetrics.adAccountName || DEFAULT_META_AD_ACCOUNT_NAME}${String(metaAdsMetrics.currency || cachedPrimaryAdAccountCurrency).toUpperCase() === "USD" ? ` · dólar ${formatMoney(metaAdsMetrics.usdArsRate || usdArsRate)} para métricas financieras` : ""}`
    : "";
  const selectedAdSpendCardText = selectedAdSpend
    ? `${selectedSpendSource}${selectedAdSpendDetail ? ` · ${selectedAdSpendDetail}` : ""}${metaAdsMetrics?.updatedAt ? ` · ${formatRelativeTime(metaAdsMetrics.updatedAt)}` : ""}`
    : selectedMetaAdsUnavailable
      ? `${selectedSpendSource}${metaAdsMetrics?.updatedAt ? ` · último intento ${formatRelativeTime(metaAdsMetrics.updatedAt)}` : ""}`
      : "Sin inversion cargada";
  const selectedRoasDetail = selectedAdSpend
    ? `${formatMoney(selectedRevenue)} / ${formatMoney(selectedAdSpend)}`
    : selectedMetaAdsUnavailable
      ? "Meta Ads no entregó gasto para este día"
      : "cargá inversión para medir";
  const selectedProfit = selectedRevenue - selectedAdSpend;
  const selectedRoas = selectedAdSpend > 0 ? selectedRevenue / selectedAdSpend : Number.NaN;
  const selectedRoi = selectedAdSpend > 0 ? (selectedProfit / selectedAdSpend) * 100 : Number.NaN;
  const selectedCpa = selectedSales > 0 ? Math.round(selectedAdSpend / selectedSales) : 0;
  const selectedCpl = selectedChats > 0 ? Math.round(selectedAdSpend / selectedChats) : 0;
  const selectedConversionRate = selectedChats ? (selectedSales / selectedChats) * 100 : 0;
  const selectedInteractionRate = selectedCrmChats ? (selectedInterestedChats / selectedCrmChats) * 100 : 0;
  const selectedInterestedConversionRate = selectedInterestedChats ? (selectedSales / selectedInterestedChats) * 100 : 0;
  const selectedAverageTicket = selectedSales ? Math.round(selectedRevenue / selectedSales) : 0;
  const interactionMetrics = {
    chats: selectedCrmChats,
    oneReply: selectedOneReplyChats,
    twoReplies: selectedTwoReplyChats,
    threePlusReplies: selectedHotChats,
    interested: selectedInterestedChats,
    hot: selectedHotChats,
    sales: selectedSales,
    adSpend: selectedAdSpend,
    cpl: selectedCpl,
    roas: selectedRoas,
    conversionRate: selectedConversionRate,
    interactionRate: selectedInteractionRate,
    source: `${selectedCrmChats} chats CRM atribuidos a anuncios`,
  };
  const decisionMetrics = {
    adSpend: selectedAdSpend,
    revenue: selectedRevenue,
    profit: selectedProfit,
    roas: selectedRoas,
    sales: selectedSales,
  };
  const adsDecision = buildAdsDecision(decisionMetrics);
  const salesToday = overview.todayPayments;
  const chatsToday = selectedDate === todayKey ? selectedChats : overview.todayConversations;
  const conversionRate = chatsToday ? Math.round((salesToday / chatsToday) * 100) : 0;
  const incomeSystemTotal = sumMoney(payments);
  const discountTotal = sumMoney(payments, "discount");
  const rangeDates = dateRangeKeys(incomeFilters.from, incomeFilters.to);
  const rangeSpendByDate = new Map(rangeAdSpendRows.map((row) => [row.date, Number(row.amount) || 0]));
  const rangeMetaSpendByDate = new Map(rangeMetaAdsRows.map((row) => [row.date, row]));
  const rangeAdjustmentByDate = new Map(rangeRevenueAdjustmentRows.map((row) => [row.date, Number(row.amount) || 0]));
  const rangePaymentsByDate = new Map();
  for (const payment of payments) {
    const key = localDateKey(payment.paidAt);
    const current = rangePaymentsByDate.get(key) ?? [];
    current.push(payment);
    rangePaymentsByDate.set(key, current);
  }
  const incomeSeries = rangeDates.map((date) => {
    const dayPayments = rangePaymentsByDate.get(date) ?? [];
    const systemRevenue = sumMoney(dayPayments);
    const adjustment = rangeAdjustmentByDate.get(date) ?? 0;
    const revenue = Math.max(0, systemRevenue + adjustment);
    const manualSpend = rangeSpendByDate.get(date) ?? 0;
    const adSpendAmount = effectiveAdSpend(manualSpend, rangeMetaSpendByDate.get(date), usdArsRate);
    return {
      date,
      revenue,
      systemRevenue,
      adjustment,
      adSpend: adSpendAmount,
      profit: revenue - adSpendAmount,
      sales: dayPayments.length,
    };
  });
  const incomeTotal = incomeSeries.reduce((total, day) => total + day.revenue, 0);
  const incomeAdjustmentTotal = incomeTotal - incomeSystemTotal;
  const averageTicket = payments.length ? Math.round(incomeTotal / payments.length) : 0;
  const dashboardChipFilters = { from: shiftDateKey(todayKey, -6), to: todayKey };
  const dashboardChipPayments = needs.dashboard ? listPayments(dashboardChipFilters) : [];
  const dashboardChipSpend = new Map((needs.dashboard ? listAdSpendRange(dashboardChipFilters) : []).map((row) => [row.date, Number(row.amount) || 0]));
  const dashboardChipMetaSpend = new Map((needs.dashboard ? listMetaAdsDailyMetricsRange({ ...dashboardChipFilters, adAccountId: primaryAdAccountId }) : []).map((row) => [row.date, row]));
  const dashboardChipAdjustments = new Map(
    (needs.dashboard ? listRevenueAdjustmentsRange(dashboardChipFilters) : []).map((row) => [row.date, Number(row.amount) || 0])
  );
  const dashboardPaymentsByDate = new Map();
  for (const payment of dashboardChipPayments) {
    const key = localDateKey(payment.paidAt);
    const current = dashboardPaymentsByDate.get(key) ?? [];
    current.push(payment);
    dashboardPaymentsByDate.set(key, current);
  }
  const dashboardDaySeries = dateRangeKeys(dashboardChipFilters.from, dashboardChipFilters.to).map((date) => {
    const systemRevenue = sumMoney(dashboardPaymentsByDate.get(date) ?? []);
    const revenue = Math.max(0, systemRevenue + (dashboardChipAdjustments.get(date) ?? 0));
    const manualSpend = dashboardChipSpend.get(date) ?? 0;
    const adSpendAmount = effectiveAdSpend(manualSpend, dashboardChipMetaSpend.get(date), usdArsRate);
    return { date, revenue, adSpend: adSpendAmount, profit: revenue - adSpendAmount, sales: (dashboardPaymentsByDate.get(date) ?? []).length };
  });
  const rangeAdSpendTotal = incomeSeries.reduce((total, day) => total + day.adSpend, 0);
  const rangeProfit = incomeTotal - rangeAdSpendTotal;
  const rangeRoas = rangeAdSpendTotal > 0 ? incomeTotal / rangeAdSpendTotal : Number.NaN;
  const rangeCpa = payments.length ? Math.round(rangeAdSpendTotal / payments.length) : 0;
  const rangeMetaChats = rangeMetaAdsRows.reduce((total, row) => total + metaMessagingConversationCount(row), 0);
  const rangeAttributedChats = needs.income ? listCtwaAttributedConversations(incomeFilters).length : 0;
  const rangeFallbackChats = needs.income ? countConversationSummaries({ createdFrom: incomeFilters.from, createdTo: incomeFilters.to }) : 0;
  const rangeChats = rangeMetaChats || rangeAttributedChats || rangeFallbackChats;
  const rangeCpl = rangeChats ? Math.round(rangeAdSpendTotal / rangeChats) : 0;
  const rangeConversion = rangeChats ? (payments.length / rangeChats) * 100 : 0;
  const bestIncomeDay = [...incomeSeries].sort((a, b) => b.revenue - a.revenue)[0] ?? { date: incomeFilters.from, revenue: 0, sales: 0 };
  const autoPayments = payments.filter((payment) => /automaticamente|comprobante/i.test(payment.note ?? "")).length;
  const manualPayments = Math.max(0, payments.length - autoPayments);

  const handoffRows = handoffs
    .map(
      (handoff) => `<tr>
        <td><strong>${escapeHtml(handoff.displayHandle || handoff.phoneNumber)}</strong><small>${escapeHtml(handoff.channel || "whatsapp")} · ${escapeHtml(handoff.conversationId || "sin conversationId")}</small></td>
        <td>${escapeHtml(handoff.reason)}</td>
        <td><p class="message-preview">${escapeHtml(handoff.lastMessage || "sin texto")}</p></td>
        <td><span class="date-pill">${formatDateTime(handoff.updatedAt)}</span></td>
        <td>
          <form method="post" action="/admin/handoffs/${encodeURIComponent(handoff.phoneNumber)}/resolve">
            ${adminHiddenFields(req, { section: "conversations" })}
            <button type="submit">Devolver al bot</button>
          </form>
        </td>
      </tr>`
    )
    .join("");

  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Ofiprof Admin</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0e0e10;
      --surface: #141416;
      --ink: #e8e6e1;
      --muted: #8a8680;
      --soft: #5a5750;
      --line: #2a2a2e;
      --line-soft: #1e1e22;
      --panel: #1a1a1e;
      --panel-solid: #1a1a1e;
      --sidebar: #0a0a0c;
      --sidebar-soft: #111114;
      --accent: #c9a55a;
      --accent-2: #5a8a6a;
      --good: #4a9a5a;
      --warn: #c99a3a;
      --danger: #d45a4a;
      --shadow: 0 4px 20px rgba(0, 0, 0, .4);
    }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body {
      margin: 0;
      min-height: 100dvh;
      font-family: "Geist", "Satoshi", "Segoe UI", system-ui, -apple-system, sans-serif;
      background: var(--bg);
      color: var(--ink);
      font-size: 13px;
      font-variant-numeric: tabular-nums;
    }
    body::before {
      content: "";
      position: fixed;
      inset: 0;
      pointer-events: none;
      background-image: linear-gradient(rgba(255,255,255,.015) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.01) 1px, transparent 1px);
      background-size: 24px 24px;
    }
    a { color: inherit; text-decoration: none; }
    button, input, textarea { font: inherit; }
    button {
      border: 0;
      border-radius: 6px;
      padding: 7px 10px;
      background: var(--accent);
      color: #0e0e10;
      cursor: pointer;
      font-weight: 700;
      font-size: 11px;
      letter-spacing: .02em;
      transition: opacity .15s ease, transform .15s ease, background .15s ease, color .15s ease;
    }
    button:hover { opacity: .9; transform: translateY(-1px); }
    button:active { opacity: .75; transform: translateY(0) scale(.98); }
    button:focus-visible, a:focus-visible, input:focus-visible, textarea:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    input, textarea {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 8px 10px;
      background: var(--surface);
      color: var(--ink);
      font-size: 12px;
    }
    textarea { min-height: 80px; resize: vertical; line-height: 1.4; }
    input:focus, textarea:focus { border-color: var(--accent); }
    label { display: grid; gap: 4px; color: var(--muted); font-size: 11px; font-weight: 600; }
    small { display: block; color: var(--muted); margin-top: 3px; line-height: 1.3; }
    .app-shell { position: relative; display: grid; grid-template-rows: auto minmax(0, 1fr); min-height: 100dvh; }
    .sidebar {
      position: sticky;
      top: 0;
      z-index: 20;
      min-height: 64px;
      padding: 10px 20px;
      background: var(--sidebar);
      color: var(--muted);
      border-bottom: 1px solid var(--line-soft);
      display: flex;
      flex-direction: row;
      align-items: center;
      gap: 16px;
    }
    .brand { display: flex; align-items: center; gap: 8px; margin: 0; padding: 0; border-bottom: 0; min-width: 190px; }
    .brand-mark { width: 28px; height: 28px; display: grid; place-items: center; border-radius: 6px; background: var(--accent); color: #0e0e10; font-weight: 900; font-size: 11px; letter-spacing: -.04em; flex-shrink: 0; }
    .brand strong { font-size: 13px; letter-spacing: -.02em; color: var(--ink); }
    .brand span { color: var(--soft); font-size: 10px; display: block; }
    .nav { display: grid; grid-template-columns: repeat(6, minmax(100px, 1fr)); gap: 4px; flex: 1; }
    .nav a {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 10px;
      border-radius: 6px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 500;
      transition: background .12s ease, color .12s ease;
      border-bottom: 2px solid transparent;
    }
    .nav a:hover { background: rgba(255,255,255,.04); color: var(--ink); }
    .nav a.active { background: rgba(201, 165, 90, .08); color: var(--accent); border-bottom-color: var(--accent); }
    .sidebar-card { padding: 10px 12px; border-radius: 8px; background: rgba(255,255,255,.03); color: var(--muted); font-size: 11px; margin: 0; min-width: 210px; }
    .sidebar-card strong { display: block; color: var(--warn); margin-bottom: 4px; font-size: 12px; }
    .sidebar-card [data-refresh-status] { display: inline-flex; align-items: center; min-height: 18px; color: var(--muted); cursor: pointer; }
    .sidebar-card [data-refresh-status][data-mode="pending"] { color: var(--accent); font-weight: 800; }
    .sidebar-card [data-refresh-status][data-mode="loading"] { color: var(--good); font-weight: 800; }
    .sidebar-card [data-refresh-status][data-mode="error"] { color: var(--danger); font-weight: 800; }
    .top-refresh { margin-top: 6px; padding: 5px 8px; width: 100%; background: rgba(255,255,255,.06); color: var(--ink); }
    .content { padding: 18px 24px 24px; min-width: 0; max-width: 1720px; width: 100%; margin: 0 auto; }
    h1 { margin: 0; font-size: clamp(36px, 5vw, 72px); letter-spacing: -.075em; line-height: .9; text-wrap: balance; }
    h2 { margin: 0; font-size: 16px; font-weight: 700; letter-spacing: -.02em; color: var(--ink); }
    h3 { margin: 0; font-size: 14px; letter-spacing: -.015em; }
    p { color: var(--muted); line-height: 1.5; }
    .notice { background: rgba(74, 154, 90, .1); border: 1px solid rgba(74, 154, 90, .2); color: var(--good); border-radius: 8px; padding: 10px 12px; margin-bottom: 14px; font-weight: 600; font-size: 12px; }
    .view { display: none; }
    body[data-section="dashboard"] #dashboard,
    body[data-section="ads"] #ads,
    body[data-section="conversations"] #conversations,
    body[data-section="income"] #income,
    body[data-section="flow"] #flow,
    body[data-section="settings"] #settings { display: grid; gap: 14px; }
    .metric-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
    .hero-kpi-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; }
    .secondary-kpi-grid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 10px; }
    .ops-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
    .ops-card { background: linear-gradient(180deg, rgba(255,255,255,.04), rgba(255,255,255,.02)); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; }
    .ops-card span { color: var(--muted); font-size: 10px; font-weight: 800; letter-spacing: .1em; text-transform: uppercase; }
    .ops-card strong { display: block; margin-top: 8px; font-size: 28px; line-height: 1; letter-spacing: -.05em; color: var(--ink); }
    .ops-card small { margin-top: 6px; }
    .metric-card, .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 10px;
      box-shadow: var(--shadow);
    }
    .metric-card { min-height: 110px; padding: 14px 16px; display: grid; align-content: space-between; }
    .metric-card span { color: var(--muted); font-size: 10px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; }
    .metric-card strong { font-size: clamp(24px, 3vw, 34px); letter-spacing: -.05em; line-height: 1; color: var(--ink); }
    .metric-card p { margin: 6px 0 0; font-size: 11px; color: var(--soft); }
    .kpi-card { position: relative; overflow: hidden; }
    .kpi-card::after { content: ""; position: absolute; inset: auto 0 0; height: 3px; background: var(--line); }
    .kpi-good::after { background: var(--good); }
    .kpi-warn::after { background: var(--warn); }
    .kpi-danger::after { background: var(--danger); }
    .hero-kpi { position: relative; min-height: 150px; overflow: hidden; padding: 18px; border: 1px solid var(--line); border-radius: 14px; background: radial-gradient(circle at 20% 0, rgba(255,255,255,.08), transparent 38%), linear-gradient(145deg, rgba(255,255,255,.055), rgba(255,255,255,.015)); box-shadow: var(--shadow); display: grid; align-content: space-between; }
    .hero-kpi::before { content: ""; position: absolute; inset: auto 0 0; height: 4px; background: var(--line); }
    .hero-kpi span { color: var(--muted); font-size: 10px; font-weight: 900; letter-spacing: .14em; text-transform: uppercase; }
    .hero-kpi strong { position: relative; z-index: 1; margin-top: 10px; color: var(--ink); font-size: clamp(40px, 5vw, 68px); letter-spacing: -.085em; line-height: .8; }
    .hero-kpi p { position: relative; z-index: 1; margin: 12px 0 0; color: var(--muted); font-size: 12px; }
    .hero-good::before { background: var(--good); }
    .hero-warn::before { background: var(--warn); }
    .hero-danger::before { background: var(--danger); }
    .hero-accent-volume { background: radial-gradient(circle at 15% 0, rgba(201,165,90,.24), transparent 42%), linear-gradient(145deg, rgba(255,255,255,.055), rgba(255,255,255,.015)); }
    .hero-accent-sales { background: radial-gradient(circle at 15% 0, rgba(74,154,90,.26), transparent 42%), linear-gradient(145deg, rgba(255,255,255,.055), rgba(255,255,255,.015)); }
    .hero-accent-interest { background: radial-gradient(circle at 15% 0, rgba(201,154,58,.24), transparent 42%), linear-gradient(145deg, rgba(255,255,255,.055), rgba(255,255,255,.015)); }
    .hero-accent-roas { background: radial-gradient(circle at 15% 0, rgba(90,138,106,.28), transparent 42%), linear-gradient(145deg, rgba(255,255,255,.055), rgba(255,255,255,.015)); }
    .revenue-card { overflow: visible; }
    .revenue-edit-toggle { position: absolute; top: 10px; right: 10px; width: 26px; height: 26px; display: grid; place-items: center; padding: 0; border-radius: 999px; background: rgba(255,255,255,.05); color: var(--soft); opacity: 0; transition: opacity .15s ease, color .15s ease, background .15s ease; }
    .revenue-card:hover .revenue-edit-toggle { opacity: 1; }
    .revenue-edit-toggle:hover, .revenue-edit-toggle:focus { color: var(--accent); background: rgba(201,165,90,.12); opacity: 1; }
    .adjustment-note { color: var(--warn); }
    .revenue-adjust-form { display: none; position: absolute; z-index: 10; top: 48px; right: 10px; width: min(340px, calc(100vw - 40px)); padding: 14px; border: 1px solid rgba(201,165,90,.28); border-radius: 10px; background: #101012; box-shadow: 0 24px 70px rgba(0,0,0,.55); gap: 9px; }
    .revenue-card:focus-within .revenue-adjust-form { display: grid; }
    .revenue-adjust-form strong { font-size: 14px; color: var(--ink); }
    .confirm-line { display: flex; grid-template-columns: auto 1fr; align-items: center; gap: 8px; color: var(--ink); }
    .day-performance-strip { display: flex; gap: 8px; overflow-x: auto; padding: 2px 2px 4px; }
    .day-chip { min-width: 112px; padding: 9px 11px; border-radius: 10px; border: 1px solid var(--line); background: rgba(255,255,255,.035); }
    .day-chip span { display: block; color: var(--muted); font-size: 10px; font-weight: 900; letter-spacing: .08em; text-transform: uppercase; }
    .day-chip strong { display: block; margin-top: 5px; color: var(--ink); font-size: 14px; letter-spacing: -.03em; }
    .day-chip small { margin-top: 4px; color: var(--soft); font-size: 10px; font-weight: 800; letter-spacing: .02em; }
    .day-chip.active { outline: 2px solid rgba(255,255,255,.12); }
    .day-good { border-color: rgba(74,154,90,.35); background: rgba(74,154,90,.1); }
    .day-warn { border-color: rgba(201,154,58,.38); background: rgba(201,154,58,.1); }
    .day-danger { border-color: rgba(212,90,74,.38); background: rgba(212,90,74,.1); }
    .day-neutral { border-color: var(--line); }
    .ads-hero { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(320px, .9fr); gap: 18px; align-items: center; background: radial-gradient(circle at top left, rgba(201,165,90,.18), transparent 36%), linear-gradient(135deg, rgba(255,255,255,.05), rgba(255,255,255,.015)); }
    .dashboard-split { display: grid; grid-template-columns: minmax(0, 1fr) minmax(330px, 380px); gap: 16px; align-items: start; }
    .dashboard-main { min-width: 0; display: grid; gap: 14px; }
    .dashboard-hero { grid-template-columns: minmax(0, 1fr) minmax(210px, 300px); min-height: 148px; overflow: hidden; position: relative; }
    .dashboard-hero::after { content: ""; position: absolute; inset: auto -12% -35% 36%; height: 120px; background: radial-gradient(circle, rgba(201,165,90,.18), transparent 62%); pointer-events: none; }
    .dashboard-hero .ads-day-header { position: relative; z-index: 1; }
    .dashboard-hero .ads-day-header h1 { font-size: clamp(24px, 2.4vw, 38px); line-height: .98; letter-spacing: -.055em; max-width: 520px; }
    .dashboard-hero-summary { position: relative; z-index: 1; align-self: stretch; display: grid; align-content: center; gap: 7px; padding: 16px; border: 1px solid rgba(201,165,90,.22); border-radius: 14px; background: rgba(10,10,12,.34); box-shadow: inset 0 1px 0 rgba(255,255,255,.06); }
    .dashboard-hero-summary span { color: var(--accent); font-size: 10px; font-weight: 900; letter-spacing: .13em; text-transform: uppercase; }
    .dashboard-hero-summary strong { color: var(--ink); font-size: clamp(30px, 3vw, 48px); letter-spacing: -.075em; line-height: .86; }
    .dashboard-hero-summary small { margin: 0; color: var(--muted); }
    .ads-day-header { display: flex; align-items: center; gap: 14px; }
    .ads-day-header span { color: var(--accent); font-size: 10px; font-weight: 900; letter-spacing: .14em; text-transform: uppercase; }
    .ads-day-header h1 { margin: 4px 0 0; font-size: clamp(28px, 4vw, 54px); letter-spacing: -.065em; line-height: .95; text-transform: capitalize; }
    .day-arrow { width: 38px; height: 38px; display: grid; place-items: center; border: 1px solid var(--line); border-radius: 999px; background: rgba(255,255,255,.04); color: var(--ink); font-size: 28px; font-weight: 300; }
    .day-arrow:hover { border-color: var(--accent); color: var(--accent); }
    .day-arrow.disabled { opacity: .35; pointer-events: none; color: var(--soft); }
    .ad-spend-form { display: grid; grid-template-columns: minmax(120px, .7fr) minmax(120px, .5fr) minmax(160px, 1fr) auto; gap: 10px; align-items: end; padding: 12px; border: 1px solid var(--line); border-radius: 10px; background: rgba(0,0,0,.18); }
    .ads-insight-grid { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(280px, .65fr); gap: 14px; }
    .quality-insight-grid { display: grid; grid-template-columns: minmax(360px, .95fr) minmax(0, 1.05fr); gap: 14px; }
    .ads-chart { display: grid; gap: 16px; }
    .ads-stacked-label { display: flex; justify-content: space-between; gap: 10px; color: var(--muted); font-size: 12px; }
    .ads-stacked-label strong { color: var(--ink); }
    .ads-stacked-bar { display: flex; height: 22px; overflow: hidden; border-radius: 999px; background: rgba(255,255,255,.06); border: 1px solid var(--line-soft); box-shadow: inset 0 0 0 1px rgba(255,255,255,.02); }
    .ads-stacked-segment { height: 100%; min-width: 0; box-shadow: 0 0 24px rgba(255,255,255,.08); }
    .ads-stacked-segment.recovered { background: linear-gradient(90deg, #8a6a25, var(--accent)); }
    .ads-stacked-segment.profit { background: linear-gradient(90deg, #4a9a5a, #8bd66f); }
    .ads-stacked-segment.loss { background: linear-gradient(90deg, #8e2f25, var(--danger)); }
    .ads-result-summary { display: flex; flex-wrap: wrap; gap: 8px; }
    .ads-result-summary span { display: inline-flex; align-items: center; gap: 6px; padding: 7px 9px; border: 1px solid var(--line-soft); border-radius: 999px; color: var(--muted); background: rgba(255,255,255,.035); font-size: 11px; }
    .ads-result-summary strong { color: var(--ink); }
    .ads-result-summary i { width: 8px; height: 8px; border-radius: 999px; }
    .ads-result-summary i.recovered { background: var(--accent); }
    .ads-result-summary i.profit { background: var(--good); }
    .ads-result-summary i.loss { background: var(--danger); }
    .ads-bar-row { display: grid; gap: 7px; }
    .ads-bar-label { display: flex; justify-content: space-between; gap: 10px; color: var(--muted); font-size: 12px; }
    .ads-bar-label strong { color: var(--ink); }
    .ads-bar-track { height: 16px; overflow: hidden; border-radius: 999px; background: rgba(255,255,255,.06); border: 1px solid var(--line-soft); }
    .ads-bar-fill { height: 100%; border-radius: inherit; box-shadow: 0 0 24px rgba(255,255,255,.08); }
    .ads-bar-fill.spend { background: linear-gradient(90deg, #8a6a25, var(--accent)); }
    .ads-bar-fill.revenue { background: linear-gradient(90deg, #2e6e43, var(--good)); }
    .ads-bar-fill.profit { background: linear-gradient(90deg, #4a9a5a, #8bd66f); }
    .ads-bar-fill.loss { background: linear-gradient(90deg, #8e2f25, var(--danger)); }
    .interaction-panel { background: radial-gradient(circle at top left, rgba(201,165,90,.12), transparent 40%), var(--panel); }
    .interaction-chart { display: grid; gap: 14px; }
    .interaction-row { display: grid; grid-template-columns: 120px minmax(0, 1fr) 62px; gap: 12px; align-items: center; }
    .interaction-label strong { display: block; color: var(--ink); font-size: 12px; }
    .interaction-label small { color: var(--soft); font-size: 10px; }
    .interaction-track { height: 18px; overflow: hidden; border-radius: 999px; background: rgba(255,255,255,.055); border: 1px solid var(--line-soft); }
    .interaction-fill { height: 100%; border-radius: inherit; box-shadow: 0 0 24px rgba(255,255,255,.08); }
    .interaction-fill.one { background: linear-gradient(90deg, #755c22, var(--warn)); }
    .interaction-fill.two { background: linear-gradient(90deg, #8a6a25, var(--accent)); }
    .interaction-fill.three { background: linear-gradient(90deg, #2e6e43, var(--good)); }
    .interaction-value { text-align: right; }
    .interaction-value strong { display: block; color: var(--ink); font-size: 18px; letter-spacing: -.04em; }
    .interaction-value small { color: var(--soft); font-size: 10px; }
    .interaction-diagnostic { margin-top: 16px; padding: 12px; border-radius: 10px; border: 1px solid var(--line); background: rgba(0,0,0,.18); }
    .interaction-diagnostic strong { color: var(--ink); font-size: 15px; letter-spacing: -.02em; }
    .interaction-diagnostic p { margin: 6px 0 0; font-size: 12px; }
    .diagnostic-good { border-color: rgba(74,154,90,.28); background: rgba(74,154,90,.08); }
    .diagnostic-warn { border-color: rgba(201,154,58,.32); background: rgba(201,154,58,.08); }
    .diagnostic-danger { border-color: rgba(212,90,74,.32); background: rgba(212,90,74,.08); }
    .decision-panel { display: grid; align-content: space-between; min-height: 230px; border-color: var(--line); }
    .decision-panel span { color: var(--muted); font-size: 10px; font-weight: 900; letter-spacing: .13em; text-transform: uppercase; }
    .decision-panel h2 { font-size: clamp(24px, 3vw, 38px); letter-spacing: -.06em; line-height: .95; margin-top: 10px; }
    .decision-panel p { margin: 12px 0; }
    .decision-good { border-color: rgba(74,154,90,.35); background: radial-gradient(circle at top right, rgba(74,154,90,.18), var(--panel) 45%); }
    .decision-warn { border-color: rgba(201,154,58,.38); background: radial-gradient(circle at top right, rgba(201,154,58,.18), var(--panel) 45%); }
    .decision-danger { border-color: rgba(212,90,74,.38); background: radial-gradient(circle at top right, rgba(212,90,74,.18), var(--panel) 45%); }
    .decision-stats { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; padding-top: 12px; border-top: 1px solid var(--line); }
    .decision-stats strong { color: var(--ink); font-size: 18px; letter-spacing: -.04em; }
    #dashboard .quality-insight-grid { grid-template-columns: minmax(0, 1.12fr) minmax(260px, .88fr); align-items: stretch; }
    #dashboard .interaction-panel, #dashboard .decision-panel { min-height: 0; }
    #dashboard .interaction-panel { padding: 14px; }
    #dashboard .interaction-panel .panel-header { margin-bottom: 9px; }
    #dashboard .interaction-chart { gap: 8px; }
    #dashboard .interaction-row { grid-template-columns: 96px minmax(0, 1fr) 54px; gap: 9px; }
    #dashboard .interaction-label strong { font-size: 11px; }
    #dashboard .interaction-label small { font-size: 9px; }
    #dashboard .interaction-track { height: 12px; }
    #dashboard .interaction-value strong { font-size: 15px; }
    #dashboard .interaction-diagnostic { margin-top: 10px; padding: 9px 10px; }
    #dashboard .interaction-diagnostic strong { font-size: 13px; }
    #dashboard .interaction-diagnostic p { margin: 4px 0 0; font-size: 11px; line-height: 1.35; }
    #dashboard .decision-panel { align-content: start; padding: 14px; }
    #dashboard .decision-panel h2 { margin-top: 6px; font-size: clamp(20px, 2vw, 26px); line-height: 1; }
    #dashboard .decision-panel p { margin: 8px 0; font-size: 12px; line-height: 1.4; }
    #dashboard .decision-stats { gap: 7px; padding-top: 8px; }
    #dashboard .decision-stats strong { font-size: 15px; }
    .income-hero { display: grid; grid-template-columns: minmax(0, 1fr) minmax(360px, .9fr); gap: 16px; align-items: end; background: radial-gradient(circle at 12% 0, rgba(90,138,106,.18), transparent 34%), linear-gradient(135deg, rgba(255,255,255,.05), rgba(255,255,255,.012)); }
    .income-hero h1 { font-size: clamp(34px, 5vw, 64px); letter-spacing: -.075em; line-height: .9; margin-top: 4px; }
    .income-calendar { display: grid; grid-template-columns: 1fr 1fr auto; gap: 10px; align-items: end; padding: 12px; border: 1px solid var(--line); border-radius: 10px; background: rgba(0,0,0,.18); }
    .range-shortcuts { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: 8px; }
    .range-shortcuts a { padding: 7px 10px; border-radius: 999px; background: rgba(255,255,255,.05); color: var(--muted); border: 1px solid var(--line-soft); font-size: 11px; font-weight: 800; }
    .range-shortcuts a:hover { color: var(--accent); border-color: var(--accent); }
    .range-shortcuts a.active { background: var(--accent); color: #111; border-color: var(--accent); }
    .range-chart { display: grid; gap: 13px; }
    .range-day-row { display: grid; grid-template-columns: 110px minmax(0, 1fr); gap: 12px; align-items: center; }
    .range-day-label strong { display: block; color: var(--ink); text-transform: capitalize; }
    .range-day-label span { color: var(--soft); font-size: 11px; }
    .range-bars { display: grid; gap: 5px; }
    .range-track { position: relative; height: 13px; overflow: hidden; border-radius: 999px; background: rgba(255,255,255,.045); border: 1px solid var(--line-soft); }
    .range-track span { position: absolute; right: 7px; top: 50%; transform: translateY(-50%); font-size: 9px; color: rgba(232,230,225,.82); font-weight: 800; text-shadow: 0 1px 8px rgba(0,0,0,.5); }
    .range-fill { height: 100%; border-radius: inherit; }
    .range-fill.revenue { background: linear-gradient(90deg, #2e6e43, var(--good)); }
    .range-fill.spend { background: linear-gradient(90deg, #8a6a25, var(--accent)); }
    .range-fill.profit { background: linear-gradient(90deg, #4a9a5a, #8bd66f); }
    .range-fill.loss { background: linear-gradient(90deg, #8e2f25, var(--danger)); }
    .chart-legend { display: flex; flex-wrap: wrap; gap: 8px; color: var(--muted); font-size: 10px; font-weight: 800; }
    .chart-legend span::before { content: ""; display: inline-block; width: 8px; height: 8px; margin-right: 5px; border-radius: 999px; }
    .chart-legend .revenue::before { background: var(--good); }
    .chart-legend .spend::before { background: var(--accent); }
    .chart-legend .profit::before { background: #8bd66f; }
    .income-insight-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; }
    .insight-card span { color: var(--muted); font-size: 10px; font-weight: 900; letter-spacing: .13em; text-transform: uppercase; }
    .insight-card strong { display: block; margin-top: 8px; color: var(--ink); font-size: 34px; letter-spacing: -.06em; }
    .insight-card p { margin: 8px 0 0; }
    .panel { padding: 16px; min-width: 0; }
    .panel-header { display: flex; justify-content: space-between; gap: 12px; align-items: center; margin-bottom: 12px; }
    .recent-rail { position: sticky; top: 84px; display: grid; gap: 10px; max-height: calc(100dvh - 104px); overflow: auto; padding: 14px; border: 1px solid rgba(201,165,90,.16); border-radius: 16px; background: radial-gradient(circle at 85% 0, rgba(201,165,90,.12), transparent 36%), rgba(20,20,22,.82); box-shadow: var(--shadow), inset 0 1px 0 rgba(255,255,255,.05); backdrop-filter: blur(16px); }
    .recent-rail-header { display: flex; justify-content: space-between; gap: 10px; align-items: flex-start; padding-bottom: 8px; border-bottom: 1px solid var(--line-soft); }
    .recent-rail-header h2 { font-size: 18px; letter-spacing: -.04em; }
    .recent-card { display: grid; gap: 9px; padding: 12px; border: 1px solid var(--line-soft); border-radius: 14px; background: linear-gradient(155deg, rgba(255,255,255,.055), rgba(255,255,255,.018)); box-shadow: inset 0 1px 0 rgba(255,255,255,.035); animation: card-rise .38s cubic-bezier(.16, 1, .3, 1) both; animation-delay: calc(var(--card-index) * 55ms); }
    .recent-card:hover { border-color: rgba(201,165,90,.26); transform: translateY(-1px); transition: transform .18s ease, border-color .18s ease; }
    .recent-card-top { display: flex; justify-content: space-between; gap: 10px; align-items: flex-start; }
    .recent-card-top .badge { flex-shrink: 0; }
    .recent-card-badges { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 5px; }
    .recent-card-conversion { border-color: rgba(73, 190, 133, .52); background: linear-gradient(155deg, rgba(73, 190, 133, .16), rgba(201, 165, 90, .05)); box-shadow: inset 3px 0 0 rgba(73, 190, 133, .88), inset 0 1px 0 rgba(255,255,255,.07); }
    .conversion-badge { display: inline-flex; align-items: center; gap: 4px; padding: 5px 7px; border: 1px solid rgba(73, 190, 133, .52); border-radius: 999px; color: #d7ffe7; background: rgba(73, 190, 133, .18); font-size: 10px; font-weight: 800; letter-spacing: .04em; text-transform: uppercase; }
    .recent-card .message-preview { max-width: none; padding: 8px 0 0; border-top: 1px solid var(--line-soft); }
    .recent-card-meta { display: flex; flex-wrap: wrap; gap: 6px; color: var(--soft); font-size: 10px; }
    .recent-card-meta span { display: inline-flex; align-items: center; gap: 4px; padding: 4px 6px; border-radius: 999px; background: rgba(255,255,255,.035); }
    @keyframes card-rise { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
    .conversation-header { align-items: flex-end; }
    .conversation-toolbar { position: sticky; top: 0; z-index: 2; display: grid; grid-template-columns: minmax(240px, .9fr) 1.4fr; gap: 10px; align-items: end; margin-bottom: 12px; padding: 10px; border: 1px solid var(--line); border-radius: 8px; background: rgba(20,20,22,.96); backdrop-filter: blur(10px); }
    .management-panel { background: linear-gradient(180deg, rgba(255,255,255,.035), rgba(255,255,255,.012)); }
    .management-toolbar { top: 64px; border-color: rgba(201,165,90,.2); box-shadow: 0 12px 40px rgba(0,0,0,.28); }
    .eyebrow { display: inline-block; color: var(--accent); font-size: 10px; font-weight: 900; letter-spacing: .14em; text-transform: uppercase; margin-bottom: 5px; }
    .search-box span { color: var(--soft); text-transform: uppercase; letter-spacing: .1em; font-size: 10px; }
    form.search-box { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: end; }
    .quick-filter-pills { display: flex; flex-wrap: wrap; gap: 6px; }
    .quick-filter-pills a { background: rgba(255,255,255,.04); border: 1px solid var(--line-soft); color: var(--muted); border-radius: 999px; padding: 7px 10px; }
    .quick-filter-pills a.active { background: rgba(201,165,90,.14); border-color: var(--accent); color: var(--accent); }
    .two-col { display: grid; grid-template-columns: .8fr 1.2fr; gap: 14px; align-items: start; }
    .settings-grid, .filter-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
    .wide { grid-column: 1 / -1; }
    .flow-shell { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 14px; min-height: 720px; }
    .flow-stage { position: relative; overflow: auto; min-width: 0; min-height: 720px; border: 1px solid var(--line); border-radius: 12px; background-color: #0d0d10; background-image: radial-gradient(rgba(255,255,255,.12) 1px, transparent 1px); background-size: 20px 20px; }
    .flow-canvas { position: relative; width: 1460px; height: 820px; transform-origin: 0 0; }
    .flow-lines { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; overflow: visible; }
    .flow-line { fill: none; stroke: rgba(201,165,90,.48); stroke-width: 2; }
    .flow-node { position: absolute; width: 220px; min-height: 104px; padding: 13px 14px; text-align: left; color: var(--ink); border: 1px solid var(--line); border-radius: 10px; background: linear-gradient(150deg, #1a1a1e, #111114); box-shadow: 0 12px 32px rgba(0,0,0,.34); cursor: pointer; }
    .flow-node.editable { cursor: pointer; border-color: rgba(201,165,90,.38); }
    .flow-node.editable:hover, .flow-node.selected { border-color: var(--accent); box-shadow: 0 0 0 2px rgba(201,165,90,.12), 0 18px 40px rgba(0,0,0,.42); }
    .flow-node::before { content: ""; position: absolute; left: -5px; top: 48px; width: 8px; height: 8px; border-radius: 50%; background: var(--soft); border: 2px solid #0d0d10; }
    .flow-node::after { content: ""; position: absolute; right: -5px; top: 48px; width: 8px; height: 8px; border-radius: 50%; background: var(--accent); border: 2px solid #0d0d10; }
    .flow-node-kind { display: block; margin-bottom: 9px; color: var(--accent); font-size: 9px; font-weight: 900; letter-spacing: .12em; text-transform: uppercase; }
    .flow-node strong { display: block; font-size: 14px; }
    .flow-node small { margin-top: 6px; }
    .flow-node-state { display: inline-flex; margin-top: 9px; padding: 3px 6px; border-radius: 999px; color: var(--good); background: rgba(74,154,90,.1); font-size: 9px; font-weight: 800; }
    .flow-editor { align-self: start; position: sticky; top: 84px; display: grid; gap: 12px; padding: 16px; }
    .flow-editor-empty { min-height: 260px; display: grid; place-content: center; text-align: center; color: var(--muted); }
    .flow-editor form { display: grid; gap: 12px; }
    .flow-editor textarea { min-height: 150px; }
    .flow-detail { display: grid; gap: 10px; }
    .flow-detail > p { margin: 0; color: var(--muted); font-size: 12px; line-height: 1.45; }
    .flow-media-list { display: grid; gap: 10px; }
    .flow-media { display: grid; gap: 6px; padding: 9px; border: 1px solid var(--line-soft); border-radius: 9px; background: rgba(255,255,255,.025); }
    .flow-media span { color: var(--soft); font-size: 10px; font-weight: 800; letter-spacing: .06em; text-transform: uppercase; }
    .flow-media audio, .flow-media video, .flow-media img { width: 100%; }
    .flow-media video, .flow-media img { max-height: 210px; border-radius: 7px; background: #08080a; object-fit: contain; }
    .flow-editor-message { min-height: 18px; margin: 0; font-size: 11px; }
    .flow-editor-message.success { color: var(--good); }
    .flow-editor-message.error { color: var(--danger); }
    .flow-legend { display: flex; flex-wrap: wrap; gap: 8px; color: var(--muted); font-size: 10px; }
    .flow-legend span { padding: 5px 8px; border: 1px solid var(--line-soft); border-radius: 999px; }
    .table-shell { overflow-x: auto; border-radius: 8px; border: 1px solid var(--line); max-height: 72vh; }
    .ads-detail-panel { background: radial-gradient(circle at 6% 0, rgba(90,138,106,.12), transparent 34%), var(--panel); }
    .ads-detail-table { max-height: 58vh; }
    table { width: 100%; min-width: 800px; border-collapse: collapse; }
    th { position: sticky; top: 0; z-index: 1; text-align: left; color: var(--soft); font-size: 10px; text-transform: uppercase; letter-spacing: .1em; padding: 8px 12px; background: var(--surface); border-bottom: 1px solid var(--line); font-weight: 600; }
    td { border-top: 1px solid var(--line-soft); padding: 10px 12px; vertical-align: middle; font-size: 12px; }
    tr:hover td { background: rgba(255,255,255,.02); }
    .contact-cell strong { font-size: 13px; letter-spacing: -.01em; }
    .contact-link { color: var(--accent); font-weight: 600; font-size: 13px; letter-spacing: -.01em; }
    .contact-link:hover { text-decoration: underline; }
    .message-preview { max-width: 360px; margin: 0; color: var(--muted); font-size: 11px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .ad-preview-img { width: 76px; height: 76px; object-fit: cover; border-radius: 10px; border: 1px solid var(--line); background: rgba(255,255,255,.04); }
    .ad-preview-empty { width: 76px; height: 76px; display: grid; place-items: center; border-radius: 10px; border: 1px dashed var(--line); color: var(--soft); font-size: 10px; text-align: center; }
    .quality-donut-panel { min-height: 260px; }
    .donut-wrap { display: grid; grid-template-columns: 170px 1fr; gap: 18px; align-items: center; }
    .quality-donut { width: 160px; height: 160px; border-radius: 50%; display: grid; place-items: center; position: relative; box-shadow: inset 0 0 0 1px rgba(255,255,255,.08), 0 18px 50px rgba(0,0,0,.28); }
    .quality-donut::after { content: ""; position: absolute; inset: 28px; border-radius: 50%; background: var(--surface); box-shadow: inset 0 0 0 1px var(--line); }
    .quality-donut-center { position: relative; z-index: 1; display: grid; place-items: center; gap: 2px; text-align: center; line-height: 1; }
    .quality-donut-center strong { font-size: 32px; letter-spacing: -.04em; }
    .quality-donut-center small { color: var(--soft); font-size: 11px; }
    .donut-legend { display: grid; gap: 8px; }
    .donut-legend span { display: grid; grid-template-columns: 12px 1fr auto; gap: 7px; align-items: center; color: var(--muted); font-size: 12px; }
    .donut-legend i { width: 9px; height: 9px; border-radius: 999px; }
    .quality-mini { display: flex; width: 116px; height: 9px; overflow: hidden; border-radius: 999px; background: rgba(255,255,255,.08); border: 1px solid var(--line-soft); }
    .quality-mini span { min-width: 0; height: 100%; }
    .ads-insight-grid { display: grid; grid-template-columns: 1fr 1fr 1.2fr; gap: 14px; align-items: stretch; }
    .winner-list, .hour-list, .recommendation-list { display: grid; gap: 9px; margin: 0; padding: 0; }
    .winner-row, .hour-row, .recommendation-list li { list-style: none; padding: 10px; border: 1px solid var(--line-soft); border-radius: 10px; background: rgba(255,255,255,.035); }
    .winner-row { display: grid; grid-template-columns: 58px 1fr; gap: 10px; align-items: center; }
    .winner-preview-img { width: 58px; height: 58px; object-fit: cover; border-radius: 10px; border: 1px solid var(--line); background: rgba(255,255,255,.04); }
    .winner-preview-empty { width: 58px; height: 58px; display: grid; place-items: center; border-radius: 10px; border: 1px dashed var(--line); color: var(--soft); font-size: 9px; text-align: center; }
    .winner-row strong, .hour-row strong { display: block; color: var(--ink); font-size: 13px; }
    .winner-row span { display: block; margin-top: 5px; color: var(--accent); font-weight: 800; font-size: 12px; }
    .winner-row small { display: block; margin-top: 4px; color: var(--muted); }
    .hour-heatmap { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
    .hour-heat-cell { min-height: 92px; display: grid; align-content: space-between; gap: 6px; padding: 10px; border: 1px solid rgba(201,165,90,var(--heat-border)); border-radius: 12px; background: radial-gradient(circle at top right, rgba(117,209,132,var(--heat-opacity)), transparent 58%), linear-gradient(180deg, rgba(201,165,90,calc(var(--heat-opacity) * .55)), rgba(255,255,255,.025)); box-shadow: inset 0 0 0 1px rgba(255,255,255,.025); }
    .hour-heat-cell.best { border-color: rgba(117,209,132,.75); box-shadow: 0 0 0 1px rgba(117,209,132,.24), 0 18px 45px rgba(74,154,90,.16); }
    .hour-heat-cell span { color: var(--soft); font-size: 10px; font-weight: 900; letter-spacing: .08em; text-transform: uppercase; }
    .hour-heat-cell strong { color: var(--ink); font-size: 16px; letter-spacing: -.04em; }
    .hour-heat-cell small { color: var(--muted); font-size: 10px; line-height: 1.25; }
    .hour-summary { margin-top: 10px; padding: 11px; border: 1px solid var(--line-soft); border-radius: 12px; background: rgba(0,0,0,.18); }
    .hour-summary span { color: var(--accent); font-size: 10px; font-weight: 900; letter-spacing: .12em; text-transform: uppercase; }
    .hour-summary strong { display: block; margin-top: 5px; color: var(--ink); font-size: 13px; line-height: 1.3; }
    .hour-summary small { display: block; margin-top: 4px; color: var(--muted); font-size: 11px; }
    .recommendation-list li { color: var(--muted); line-height: 1.35; }
    .status-stack { display: grid; gap: 4px; min-width: 92px; }
    .status-stack small { color: var(--muted); white-space: nowrap; }
    .inline-action { color: var(--accent); font-weight: 700; }
    .filter-pills { display: flex; gap: 6px; }
    .filter-pills a { padding: 4px 10px; border-radius: 999px; font-size: 11px; font-weight: 600; color: var(--muted); background: rgba(255,255,255,.04); border: 1px solid var(--line-soft); transition: background .12s ease, color .12s ease, border-color .12s ease; }
    .filter-pills a:hover { background: rgba(255,255,255,.08); color: var(--ink); }
    .filter-pills a.active { background: rgba(201, 165, 90, .12); color: var(--accent); border-color: var(--accent); }
    .badge { display: inline-flex; align-items: center; width: max-content; border-radius: 999px; padding: 4px 8px; font-size: 10px; font-weight: 700; }
    .badge-good { color: var(--good); background: rgba(74, 154, 90, .12); }
    .badge-warn { color: var(--warn); background: rgba(201, 154, 58, .12); }
    .badge-soft { color: var(--accent); background: rgba(201, 165, 90, .1); }
    .badge-danger { color: var(--danger); background: rgba(212, 90, 74, .12); }
    .badge-neutral { color: var(--muted); background: rgba(255,255,255,.06); }
    .pause-inline { display: inline-flex; margin: 0; vertical-align: middle; }
    .pause-btn { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; padding: 0; border: none; border-radius: 999px; background: rgba(201, 154, 58, .15); color: var(--warn); font-size: 11px; line-height: 1; cursor: pointer; transition: background .12s ease, transform .12s ease; }
    .pause-btn:hover { background: rgba(201, 154, 58, .3); transform: scale(1.15); }
    .interest-dot { display: inline-block; width: 7px; height: 7px; margin-right: 5px; border-radius: 999px; background: var(--soft); box-shadow: 0 0 14px rgba(255,255,255,.08); }
    .interest-good { background: var(--good); box-shadow: 0 0 18px rgba(74,154,90,.35); }
    .interest-warn { background: var(--warn); box-shadow: 0 0 18px rgba(201,154,58,.35); }
    .interest-soft { background: var(--accent); box-shadow: 0 0 18px rgba(201,165,90,.28); }
    .interest-neutral { background: var(--soft); }
    .date-pill { white-space: nowrap; color: var(--soft); font-size: 11px; }
    .quick-actions { display: flex; flex-wrap: wrap; gap: 6px; min-width: 180px; }
    .quick-actions form { margin: 0; }
    .quick-actions button { padding: 6px 8px; font-size: 10px; }
    .quick-actions .accent { background: var(--accent); color: #0e0e10; font-weight: 800; }
    .quick-actions .bomb { background: linear-gradient(135deg, #f0d27a, #c77a3f); color: #111; font-weight: 900; }
    .recent-card .quick-actions { min-width: 0; padding-top: 2px; }
    .recent-card .quick-actions button { padding: 6px 7px; }
    .action-link { display: inline-flex; align-items: center; border-radius: 6px; padding: 6px 8px; background: var(--line); color: var(--ink); font-size: 10px; font-weight: 800; }
    .action-link.primary { background: var(--accent-2); color: #fff; }
    .ghost { background: var(--line); color: var(--ink); }
    .warn { background: rgba(201, 154, 58, .15); color: var(--warn); }
    .danger { color: var(--danger); }
    .money { font-weight: 700; letter-spacing: -.02em; }
    .muted-money { color: var(--muted); font-weight: 600; }
    .empty { border: 1px dashed var(--line); border-radius: 8px; padding: 16px; color: var(--soft); background: var(--surface); font-size: 12px; }
    .button-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: end; }
    .history-actions { display: flex; flex-wrap: wrap; gap: 10px; align-items: end; margin-bottom: 12px; }
    .history-actions form { display: flex; flex-wrap: wrap; gap: 8px; align-items: end; }
    .history-actions label { min-width: min(280px, 100%); }
    .secondary { background: var(--accent-2); color: #fff; }
    .filter-card { display: grid; gap: 10px; }
    code { background: var(--line); padding: 2px 5px; border-radius: 4px; font-size: 11px; }
    @media (max-width: 1240px) {
      .dashboard-split { grid-template-columns: 1fr; }
      .recent-rail { position: static; max-height: none; }
    }
    @media (max-width: 1060px) {
      .sidebar { flex-wrap: wrap; gap: 12px; padding: 12px 16px; }
      .brand { min-width: unset; }
      .sidebar-card { position: static; flex: 1; min-width: 220px; }
      .nav { grid-template-columns: repeat(5, minmax(0, 1fr)); flex: 1 1 100%; order: 3; }
      .nav a { justify-content: center; text-align: center; border-left: none; border-bottom: 2px solid transparent; }
      .nav a.active { border-bottom-color: var(--accent); }
      .nav a span:last-child { display: none; }
      .metric-grid, .ops-grid, .hero-kpi-grid, .secondary-kpi-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .ads-hero, .dashboard-hero, .ads-insight-grid, .quality-insight-grid { grid-template-columns: 1fr; }
      .income-hero, .income-insight-grid { grid-template-columns: 1fr; }
      .income-calendar { grid-template-columns: 1fr; }
      .ad-spend-form { grid-template-columns: 1fr; }
      .conversation-toolbar { grid-template-columns: 1fr; }
      .two-col { grid-template-columns: 1fr; }
      .hour-heatmap { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
    @media (max-width: 680px) {
      .content { padding: 14px; }
      .sidebar { position: sticky; padding: 12px; }
      .nav { grid-template-columns: 1fr 1fr; }
      .metric-grid, .ops-grid, .settings-grid, .filter-grid { grid-template-columns: 1fr; }
      .flow-shell { grid-template-columns: 1fr; }
      .flow-editor { position: static; }
      #dashboard { gap: 10px; }
      .dashboard-split, .dashboard-main { gap: 10px; }
      .panel { padding: 12px; border-radius: 8px; }
      .panel-header { display: grid; }
      .dashboard-hero { min-height: 0; gap: 10px; padding: 12px; }
      .dashboard-hero .ads-day-header { display: grid; grid-template-columns: 30px minmax(0, 1fr) 30px; gap: 9px; align-items: center; }
      .dashboard-hero .ads-day-header h1 { font-size: 22px; line-height: 1; }
      .dashboard-hero .ads-day-header small { font-size: 10px; }
      .dashboard-hero .ads-day-header .badge { grid-column: 2 / 3; width: max-content; margin-top: 2px; }
      .day-arrow { width: 30px; height: 30px; font-size: 22px; }
      .dashboard-hero-summary { padding: 10px; border-radius: 10px; }
      .dashboard-hero-summary strong { font-size: 28px; }
      .dashboard-hero-summary small { font-size: 10px; }
      .day-performance-strip { gap: 6px; padding-bottom: 2px; }
      .day-chip { min-width: 92px; padding: 7px 8px; border-radius: 8px; }
      .day-chip strong { font-size: 12px; }
      .day-chip small { font-size: 9px; }
      .hero-kpi-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
      .secondary-kpi-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
      .hero-kpi { min-height: 92px; padding: 10px; border-radius: 10px; }
      .hero-kpi span, .metric-card span { font-size: 8px; letter-spacing: .09em; }
      .hero-kpi strong { margin-top: 6px; font-size: clamp(24px, 10vw, 36px); letter-spacing: -.07em; }
      .hero-kpi p { margin-top: 7px; font-size: 10px; line-height: 1.25; }
      .metric-card { min-height: 88px; padding: 10px; border-radius: 9px; }
      .metric-card strong { font-size: clamp(20px, 8vw, 28px); }
      .metric-card p { margin-top: 5px; font-size: 10px; line-height: 1.25; }
      .revenue-edit-toggle { opacity: 1; top: 8px; right: 8px; width: 22px; height: 22px; }
      #dashboard .quality-insight-grid { grid-template-columns: 1fr; gap: 10px; }
      #dashboard .interaction-panel, #dashboard .decision-panel { padding: 12px; }
      #dashboard .decision-panel h2 { font-size: 20px; }
      #dashboard .decision-panel p { font-size: 11px; }
      .recent-rail { border-radius: 12px; padding: 10px; gap: 8px; background: rgba(20,20,22,.62); }
      .recent-rail-header { padding-bottom: 6px; }
      .recent-rail-header h2 { font-size: 15px; }
      .recent-rail-header small { display: none; }
      .recent-card { padding: 9px; gap: 7px; border-radius: 10px; }
      .recent-card:nth-of-type(n + 4) { display: none; }
      .recent-card .message-preview { padding-top: 6px; -webkit-line-clamp: 1; }
      .recent-card-meta { font-size: 9px; gap: 4px; }
      .recent-card .quick-actions { gap: 4px; }
      .recent-card .quick-actions button { padding: 5px 6px; font-size: 9px; }
      .interaction-row { grid-template-columns: 1fr; gap: 6px; }
      .interaction-value { text-align: left; display: flex; gap: 8px; align-items: baseline; }
      .range-day-row { grid-template-columns: 1fr; }
      .donut-wrap { grid-template-columns: 1fr; justify-items: center; }
      .hour-heat-cell { min-height: 82px; }
    }
  </style>
</head>
<body data-section="${escapeHtml(activeSection)}">
  <div class="app-shell">
    <aside class="sidebar">
      <div class="brand">
        <div class="brand-mark">Of</div>
        <div><strong>Ofiprof Admin</strong><span>Control comercial Fantasía Color PRO</span></div>
      </div>
      <nav class="nav" aria-label="Panel admin">
        <a class="${activeSection === "dashboard" ? "active" : ""}" href="${adminSectionPath(req, "dashboard")}"><span>Dashboard</span><span>${salesToday}</span></a>
        <a class="${activeSection === "ads" ? "active" : ""}" href="${adminSectionPath(req, "ads")}"><span>Ads</span><span>Meta</span></a>
        <a class="${activeSection === "conversations" ? "active" : ""}" href="${adminSectionPath(req, "conversations")}"><span>Conversaciones</span><span>${overview.todayConversations}</span></a>
        <a class="${activeSection === "income" ? "active" : ""}" href="${adminSectionPath(req, "income", incomeFilters)}"><span>Ingresos</span><span>${formatMoney(overview.paymentTotal)}</span></a>
        <a class="${activeSection === "flow" ? "active" : ""}" href="${adminSectionPath(req, "flow")}"><span>Flujo</span><span>Nodos</span></a>
        <a class="${activeSection === "settings" ? "active" : ""}" href="${adminSectionPath(req, "settings")}"><span>Configuracion</span><span>AI</span></a>
      </nav>
      <div class="sidebar-card">
        <strong>${overview.handoffs} en revision humana</strong>
        <span data-refresh-status>Actualizado ahora</span>
        <button type="button" class="top-refresh" data-manual-refresh>Actualizar</button>
      </div>
    </aside>

    <main class="content">
      ${statusBanner}

      ${activeSection === "dashboard" ? `<section class="view" id="dashboard">
        <div class="dashboard-split">
          <div class="dashboard-main">
            <section class="panel ads-hero dashboard-hero">
              <div class="ads-day-header">
                <a class="day-arrow" href="${adminSectionPath(req, "dashboard", { date: previousDate })}" aria-label="Dia anterior">‹</a>
                <div>
                  <span>Panel de rentabilidad</span>
                  <h1>${escapeHtml(formatDashboardDate(selectedDate))}</h1>
                  <small>${selectedDate === todayKey ? "Hoy" : `Dia seleccionado ${selectedDate}`}</small>
                </div>
                ${selectedDate < todayKey ? `<a class="day-arrow" href="${adminSectionPath(req, "dashboard", { date: nextDate })}" aria-label="Dia siguiente">›</a>` : `<span class="day-arrow disabled" aria-label="No hay dias futuros">›</span>`}
                <a class="badge badge-neutral" href="${adminSectionPath(req, "dashboard", { date: todayKey })}">Hoy</a>
              </div>
              <div class="dashboard-hero-summary">
                <span>Resumen operativo</span>
                <strong>${formatMoney(selectedProfit)}</strong>
                <small>${selectedSales} ventas · ${selectedChats} chats · ROAS ${formatMultiple(selectedRoas)}</small>
              </div>
            </section>
            ${renderDayPerformanceChips(req, dashboardDaySeries, selectedDate, "dashboard", { showRoas: true })}
            <div class="hero-kpi-grid">
              ${renderHeroKpiCard("Conversaciones iniciadas", String(selectedChats), selectedChats ? `${selectedChatsSource}${selectedAdSpend ? ` · ${formatMoney(selectedCpl)} por chat` : " · sin inversión cargada"}` : "sin chats nuevos este día", selectedChats ? "good" : "", "volume")}
              ${renderHeroKpiCard("Ventas", String(selectedSales), `${formatPercent(selectedConversionRate)} conversion chat-venta`, selectedConversionRate >= 8 ? "good" : selectedConversionRate >= 3 ? "warn" : selectedChats ? "danger" : "", "sales")}
              ${renderHeroKpiCard("Interesados", String(selectedInterestedChats), `${formatPercent(selectedInteractionRate)} de ${selectedCrmChats} CRM atribuidos · ${selectedHotChats} hot`, selectedInteractionRate >= 35 ? "good" : selectedInteractionRate >= 15 ? "warn" : selectedCrmChats ? "danger" : "", "interest")}
              ${renderHeroKpiCard("ROAS", formatMultiple(selectedRoas), selectedRoasDetail, selectedRoas >= 2 ? "good" : selectedRoas >= 1 ? "warn" : selectedAdSpend ? "danger" : selectedMetaAdsUnavailable ? "warn" : "", "roas")}
            </div>
            <div class="secondary-kpi-grid">
              ${renderRevenueCorrectionCard(req, {
                date: selectedDate,
                systemRevenue: selectedSystemRevenue,
                revenue: selectedRevenue,
                sales: selectedSales,
                adjustment: revenueAdjustment,
              })}
              ${renderKpiCard("Inversion Ads", selectedAdSpendLabel, selectedAdSpendCardText, selectedMetaAdsUnavailable ? "danger" : "warn")}
              ${renderKpiCard("Ganancia estimada", formatMoney(selectedProfit), `${formatPercent(selectedRoi)} ROI`, selectedProfit >= 0 ? "good" : "danger")}
              ${renderKpiCard("CPA", selectedSales ? formatMoney(selectedCpa) : "-", `${selectedSales} ventas`, selectedCpa && selectedCpa < selectedAverageTicket ? "good" : selectedCpa ? "warn" : "")}
              ${renderKpiCard("Costo por chat", selectedChats ? formatMoney(selectedCpl) : "-", `${selectedChats} chats · ${selectedChatsSource}`, "")}
            </div>
            <section class="quality-insight-grid">
              ${renderInteractionChart(interactionMetrics)}
              <section class="panel decision-panel decision-${adsDecision.tone}">
                <span>Decision sugerida</span>
                <h2>${escapeHtml(adsDecision.title)}</h2>
                <p>${escapeHtml(adsDecision.text)}</p>
                <div class="decision-stats">
                  <small>Interesados a venta</small><strong>${selectedInterestedChats ? formatPercent(selectedInterestedConversionRate) : "-"}</strong>
                  <small>Conversión chat-venta</small><strong>${formatPercent(selectedConversionRate)}</strong>
                </div>
              </section>
            </section>
            ${renderAdsChart(decisionMetrics)}
            <section class="panel"><div class="panel-header"><div><h2>Detalle de anuncios</h2><small>Se carga bajo demanda para que este panel abra más rápido.</small></div><a class="badge badge-neutral" href="${adminSectionPath(req, "ads")}">Abrir Ads</a></div></section>
          </div>
          ${renderRecentConversationRail(req, dashboardConversations)}
        </div>
      </section>` : ""}

      ${activeSection === "ads" ? renderAdsDashboard(req, adsDashboard) : ""}

      ${activeSection === "conversations" ? `<section class="view" id="conversations">
        <section class="panel">
          <div class="panel-header">
            <div><h2>Handoffs pendientes</h2><small>${handoffs.length} chats pausados para atencion manual</small></div>
            ${handoffs.length ? `<form method="post" action="/admin/handoffs/resolve-all" onsubmit="return confirm('Esto va a devolver todos los chats en revision al bot. Continuar?')">${adminHiddenFields(req, { section: "conversations" })}<button type="submit" class="secondary">Devolver todos al bot</button></form>` : ""}
          </div>
          ${handoffs.length ? `<div class="table-shell"><table><thead><tr><th>Contacto</th><th>Motivo</th><th>Ultimo mensaje</th><th>Fecha</th><th>Accion</th></tr></thead><tbody>${handoffRows}</tbody></table></div>` : `<div class="empty">No hay conversaciones pausadas ahora.</div>`}
        </section>
        ${renderConversationSection(req, paginatedConversations, {
          section: "conversations",
          convFilter,
          quickFilter,
          search: conversationSearch,
          total: conversationTotal,
          page: conversationPage,
          pageSize: conversationPageSize,
        })}
      </section>` : ""}

      ${activeSection === "income" ? `<section class="view" id="income">
        <section class="panel income-hero">
          <div>
            <span class="eyebrow">Analisis financiero</span>
            <h1>Ingresos y rentabilidad</h1>
            <small>${escapeHtml(formatDateLong(incomeFilters.from))} al ${escapeHtml(formatDateLong(incomeFilters.to))}</small>
          </div>
          <form method="get" action="/admin" class="income-calendar">
            ${adminHiddenFields(req, { section: "income" })}
            <label>Desde<input type="date" name="from" value="${escapeHtml(incomeFilters.from)}"></label>
            <label>Hasta<input type="date" name="to" value="${escapeHtml(incomeFilters.to)}"></label>
            <button class="secondary" type="submit">Aplicar</button>
          </form>
          <div class="range-shortcuts">
            <a href="${adminSectionPath(req, "income", { from: todayKey, to: todayKey })}">Hoy</a>
            <a href="${adminSectionPath(req, "income", { from: shiftDateKey(todayKey, -1), to: shiftDateKey(todayKey, -1) })}">Ayer</a>
            <a href="${adminSectionPath(req, "income", { from: shiftDateKey(todayKey, -6), to: todayKey })}">Ultimos 7 dias</a>
            <a href="${adminSectionPath(req, "income", { from: `${todayKey.slice(0, 8)}01`, to: todayKey })}">Este mes</a>
          </div>
        </section>
        ${renderDayPerformanceChips(req, incomeSeries, "", "income")}
        <div class="metric-grid">
          ${renderKpiCard("Facturacion", formatMoney(incomeTotal), `${payments.length} ventas en el rango`, "good")}
          ${renderKpiCard("Ganancia estimada", formatMoney(rangeProfit), `Inversion ${formatMoney(rangeAdSpendTotal)}`, rangeProfit >= 0 ? "good" : "danger")}
          ${renderKpiCard("ROAS", formatMultiple(rangeRoas), rangeAdSpendTotal ? `Retorno sobre ${formatMoney(rangeAdSpendTotal)}` : "Sin inversion cargada", rangeRoas >= 2 ? "good" : rangeRoas >= 1 ? "warn" : rangeAdSpendTotal ? "danger" : "")}
          ${renderKpiCard("CPA", payments.length ? formatMoney(rangeCpa) : "-", `${payments.length} ventas`, rangeCpa && rangeCpa < averageTicket ? "good" : rangeCpa ? "warn" : "")}
          ${renderKpiCard("Costo por chat", rangeChats ? formatMoney(rangeCpl) : "-", `${rangeChats} chats creados`, "")}
          ${renderKpiCard("Conversion", formatPercent(rangeConversion), `${payments.length} ventas / ${rangeChats} chats`, rangeConversion >= 8 ? "good" : rangeConversion >= 3 ? "warn" : rangeChats ? "danger" : "")}
          ${renderKpiCard("Ticket promedio", payments.length ? formatMoney(averageTicket) : "-", "Promedio por venta", "")}
          ${renderKpiCard("Mejor dia", formatMoney(bestIncomeDay.revenue), `${formatDateLong(bestIncomeDay.date)} · ${bestIncomeDay.sales} ventas`, "good")}
        </div>
        ${renderRangeChart(incomeSeries)}
        <section class="income-insight-grid">
          <article class="panel insight-card"><span>Origen de ventas</span><strong>${autoPayments}</strong><p>Ventas automaticas por comprobante</p><small>${manualPayments} ventas manuales o registradas desde admin</small></article>
          <article class="panel insight-card"><span>Promedio diario</span><strong>${formatMoney(Math.round(incomeTotal / Math.max(rangeDates.length, 1)))}</strong><p>Facturacion promedio por dia del rango</p><small>${formatMoney(Math.round(rangeAdSpendTotal / Math.max(rangeDates.length, 1)))} de inversion diaria promedio</small></article>
          <article class="panel insight-card"><span>Ajustes netos</span><strong>${formatSignedMoney(incomeAdjustmentTotal)}</strong><p>Correcciones aplicadas al rango</p><small>Sistema ${formatMoney(incomeSystemTotal)} · Total corregido ${formatMoney(incomeTotal)}</small></article>
          <article class="panel insight-card"><span>Bonificaciones</span><strong>${formatMoney(discountTotal)}</strong><p>Descuento acumulado registrado</p><small>Total historico ${formatMoney(overview.paymentTotal)}</small></article>
        </section>
        <section class="panel">
          <div class="panel-header"><div><h2>Detalle de ventas del rango</h2><small>Auditoria compacta de pagos registrados</small></div></div>
          ${renderPaymentsTable(payments)}
        </section>
      </section>` : ""}

      ${activeSection === "flow" ? `<section class="view" id="flow">
        <section class="panel">
          <div class="panel-header">
            <div><span class="eyebrow">Mapa operativo</span><h2>Flujo de conversación</h2><small>Seleccioná cualquier nodo para entender qué hace y reproducir los medios asociados. Los nodos dorados además permiten editar su contenido.</small></div>
            <div class="flow-legend"><span>Disparador</span><span>Condición</span><span>Mensaje editable</span><span>Acción</span></div>
          </div>
          <div class="flow-shell" data-flow-root>
            <div class="flow-stage" data-flow-stage><div class="flow-canvas" data-flow-canvas><svg class="flow-lines" data-flow-lines aria-hidden="true"></svg></div></div>
            <aside class="panel flow-editor" data-flow-editor>
              <div class="flow-editor-empty"><strong>Seleccioná un nodo</strong><small>Vas a ver su explicación operativa y, cuando corresponda, sus audios, imágenes o video.</small></div>
            </aside>
          </div>
        </section>
      </section>` : ""}

      ${activeSection === "settings" ? `<section class="view" id="settings">
        <section class="panel">
          <div class="panel-header"><h2>Configuracion del bot</h2></div>
          <form method="post" action="/admin/settings">
            ${adminHiddenFields(req, { section: "settings" })}
            <div class="settings-grid">
              <label class="wide">Prompt maestro<textarea name="master_prompt">${escapeHtml(settings.master_prompt)}</textarea></label>
              <label class="wide">Regla de respuestas siguientes<textarea name="next_reply_prompt">${escapeHtml(settings.next_reply_prompt)}</textarea></label>
              <label class="wide">Regla para compradores<textarea name="paid_reply_prompt">${escapeHtml(settings.paid_reply_prompt)}</textarea></label>
              <label class="wide">Información inicial<textarea name="initial_offer_text">${escapeHtml(settings.initial_offer_text ?? "")}</textarea></label>
              <label class="wide">Mensaje de la landing<textarea name="product_landing_text">${escapeHtml(settings.product_landing_text ?? "")}</textarea></label>
              <label class="wide">URL de la landing<input name="product_landing_url" value="${escapeHtml(settings.product_landing_url ?? "")}"></label>
              <label class="wide">Alias de pago<input name="payment_alias" value="${escapeHtml(settings.payment_alias ?? "")}"></label>
              <label class="wide">Presentación del titular<input name="payment_alias_note" value="${escapeHtml(settings.payment_alias_note ?? "")}"></label>
              <label class="wide">Instrucciones después del alias<textarea name="payment_instructions_text">${escapeHtml(settings.payment_instructions_text ?? "")}</textarea></label>
              <label class="wide">Recordatorio 23h<textarea name="reminder2_offer_text">${escapeHtml(settings.reminder2_offer_text ?? "")}</textarea></label>
              <label class="wide">Oferta exclusiva por respuesta<textarea name="exclusive_offer_text">${escapeHtml(settings.exclusive_offer_text ?? "")}</textarea></label>
              <label class="wide">Descuento final 23h<textarea name="final_discount_text">${escapeHtml(settings.final_discount_text ?? "")}</textarea></label>
              <label class="wide">Oferta manual<textarea name="flash_offer_text">${escapeHtml(settings.flash_offer_text ?? "")}</textarea></label>
              <label class="wide">Link de acceso al producto<input name="product_access_url" value="${escapeHtml(settings.product_access_url)}"></label>
              <label class="wide">Mensaje de entrega post-pago<textarea name="product_delivery_text">${escapeHtml(settings.product_delivery_text)}</textarea></label>
              <label class="wide">Pixel/Dataset Meta para conversiones IG/FB<input name="meta_ads_destination_id" value="${escapeHtml(settings.meta_ads_destination_id ?? "")}" placeholder="ID del Pixel o Dataset"></label>
              <label>Max tokens OpenAI<input name="openai_max_tokens" type="number" min="60" max="800" value="${escapeHtml(settings.openai_max_tokens)}"></label>
            </div>
            <div class="button-row" style="margin-top:18px"><button class="secondary" type="submit">Guardar configuracion</button></div>
          </form>
        </section>
      </section>` : ""}
    </main>
  </div>
  <script>
    (() => {
      const status = document.querySelector('[data-refresh-status]');
      const refreshButton = document.querySelector('[data-manual-refresh]');
      const params = new URLSearchParams(window.location.search);
      const token = params.get('token');
      const apiUrl = '/admin/api/revision' + (token ? '?token=' + encodeURIComponent(token) : '');
      const initialUpdatedAt = ${JSON.stringify(overview.updatedAt ?? "")};
      let snapshot = {
        conversations: ${overview.conversations},
        handoffs: ${overview.handoffs},
        payments: ${overview.payments},
        paymentTotal: ${overview.paymentTotal},
        todayPayments: ${overview.todayPayments},
        todayConversations: ${overview.todayConversations},
        updatedAt: initialUpdatedAt,
        metaUpdatedAt: ${JSON.stringify(overview.metaUpdatedAt ?? "")},
      };
      let lastCheckAt = Date.now();
      let pendingReload = false;
      let checkingUpdates = false;

      const setStatus = (text, mode = '') => {
        if (!status) return;
        status.textContent = text;
        status.dataset.mode = mode;
      };

      const hasChanged = (nextSnapshot) => {
        const changed =
          nextSnapshot.conversations !== snapshot.conversations ||
          nextSnapshot.handoffs !== snapshot.handoffs ||
          nextSnapshot.payments !== snapshot.payments ||
          nextSnapshot.paymentTotal !== snapshot.paymentTotal ||
          nextSnapshot.todayPayments !== snapshot.todayPayments ||
          nextSnapshot.todayConversations !== snapshot.todayConversations ||
          nextSnapshot.updatedAt !== snapshot.updatedAt ||
          nextSnapshot.metaUpdatedAt !== snapshot.metaUpdatedAt;

        snapshot = nextSnapshot;
        return changed;
      };

      const checkUpdates = async () => {
        if (document.hidden || pendingReload || checkingUpdates) return;
        checkingUpdates = true;
        setStatus('Buscando cambios...', 'loading');

        try {
          const res = await fetch(apiUrl, { cache: 'no-store' });
          if (!res.ok) throw new Error('admin api ' + res.status);

          const data = await res.json();
          if (hasChanged(data)) {
            pendingReload = true;
            setStatus('Hay cambios nuevos. Actualizar', 'pending');
            return;
          }

          lastCheckAt = Date.now();
          setStatus('Sin cambios. Revisado ahora');
        } catch (err) {
          setStatus('Sin actualizar. Revisar conexion', 'error');
        } finally {
          checkingUpdates = false;
        }
      };

      refreshButton?.addEventListener('click', () => {
        const url = new URL(window.location.href);
        url.searchParams.set('refresh', '1');
        window.location.assign(url);
      });
      status?.addEventListener('click', () => {
        if (pendingReload) window.location.reload();
        else checkUpdates();
      });

      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) checkUpdates();
      });
      window.addEventListener('focus', checkUpdates);
      setStatus('Sin polling. Se revisa al volver a la pestaña');
    })();

    (() => {
      if (document.body.dataset.section !== 'flow') return;
      const root = document.querySelector('[data-flow-root]');
      if (!root) return;
      const canvas = root.querySelector('[data-flow-canvas]');
      const lines = root.querySelector('[data-flow-lines]');
      const editor = root.querySelector('[data-flow-editor]');
      const params = new URLSearchParams(window.location.search);
      const token = params.get('token');
      const endpoint = '/admin/api/flow' + (token ? '?token=' + encodeURIComponent(token) : '');
      let flow;

      const escapeText = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
      const renderNodeDetail = (node) => {
        const description = node.description ? '<p>' + escapeText(node.description) + '</p>' : '';
        const media = (node.media || []).map((item) => {
          const label = '<span>' + escapeText(item.label) + '</span>';
          const src = escapeText(item.src);
          if (item.type === 'audio') return '<div class="flow-media">' + label + '<audio controls preload="metadata" src="' + src + '"></audio></div>';
          if (item.type === 'video') return '<div class="flow-media">' + label + '<video controls preload="metadata" src="' + src + '"></video></div>';
          if (item.type === 'image') return '<div class="flow-media">' + label + '<img loading="lazy" src="' + src + '" alt="' + escapeText(item.label) + '"></div>';
          return '';
        }).join('');
        return '<div class="flow-detail"><div><span class="eyebrow">' + (node.editable ? 'Contenido y medios' : 'Detalle operativo') + '</span><h2>' + escapeText(node.title) + '</h2><small>' + escapeText(node.subtitle) + '</small></div>' + description + (media ? '<div class="flow-media-list">' + media + '</div>' : '') + '</div>';
      };
      const drawLines = () => {
        lines.innerHTML = '';
        for (const edge of flow.edges) {
          const source = canvas.querySelector('[data-node-id="' + edge.source + '"]');
          const target = canvas.querySelector('[data-node-id="' + edge.target + '"]');
          if (!source || !target) continue;
          const x1 = source.offsetLeft + source.offsetWidth;
          const y1 = source.offsetTop + source.offsetHeight / 2;
          const x2 = target.offsetLeft;
          const y2 = target.offsetTop + target.offsetHeight / 2;
          const bend = Math.max(50, (x2 - x1) / 2);
          const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          path.setAttribute('class', 'flow-line');
          path.setAttribute('d', 'M ' + x1 + ' ' + y1 + ' C ' + (x1 + bend) + ' ' + y1 + ', ' + (x2 - bend) + ' ' + y2 + ', ' + x2 + ' ' + y2);
          lines.appendChild(path);
        }
      };
      const openEditor = (node) => {
        canvas.querySelectorAll('.flow-node').forEach((item) => item.classList.toggle('selected', item.dataset.nodeId === node.id));
        if (!node.editable) {
          editor.innerHTML = renderNodeDetail(node) + '<small>Este paso es de solo lectura desde el diagrama.</small>';
          return;
        }
        const fields = node.fields.map((field) => {
          const attrs = 'name="' + escapeText(field.key) + '" maxlength="' + (field.maxLength || '') + '"';
          if (field.input === 'number') return '<label>' + escapeText(field.label) + '<input type="number" ' + attrs + ' min="' + field.min + '" max="' + field.max + '" value="' + escapeText(field.value) + '"></label>';
          if (field.input === 'url') return '<label>' + escapeText(field.label) + '<input type="url" ' + attrs + ' value="' + escapeText(field.value) + '"></label>';
          return '<label>' + escapeText(field.label) + '<textarea ' + attrs + '>' + escapeText(field.value) + '</textarea></label>';
        }).join('');
        editor.innerHTML = renderNodeDetail(node) + '<form data-flow-form><span class="eyebrow">Editar contenido</span>' + fields + '<p class="flow-editor-message" data-flow-message></p><button type="submit">Guardar cambios</button></form>';
        editor.querySelector('form').addEventListener('submit', async (event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const message = form.querySelector('[data-flow-message]');
          const button = form.querySelector('button');
          const settings = Object.fromEntries(new FormData(form).entries());
          button.disabled = true;
          message.className = 'flow-editor-message';
          message.textContent = 'Guardando...';
          try {
            const response = await fetch(endpoint, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ settings }) });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'No se pudo guardar.');
            flow = data.flow;
            message.className = 'flow-editor-message success';
            message.textContent = 'Cambios guardados y sincronizados.';
            renderNodes(false);
          } catch (error) {
            message.className = 'flow-editor-message error';
            message.textContent = error.message;
          } finally {
            button.disabled = false;
          }
        });
      };
      const renderNodes = (resetEditor = true) => {
        canvas.querySelectorAll('.flow-node').forEach((node) => node.remove());
        for (const node of flow.nodes) {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'flow-node' + (node.editable ? ' editable' : '');
          button.dataset.nodeId = node.id;
          button.style.left = node.x + 'px';
          button.style.top = node.y + 'px';
          button.innerHTML = '<span class="flow-node-kind">' + escapeText(node.type) + '</span><strong>' + escapeText(node.title) + '</strong><small>' + escapeText(node.subtitle) + '</small>' + (node.editable ? '<span class="flow-node-state">Editable</span>' : '');
          button.addEventListener('click', () => openEditor(node));
          canvas.appendChild(button);
        }
        drawLines();
        if (resetEditor) editor.innerHTML = '<div class="flow-editor-empty"><strong>Seleccioná un nodo</strong><small>Vas a ver su explicación operativa y, cuando corresponda, sus audios, imágenes o video.</small></div>';
      };
      fetch(endpoint, { cache: 'no-store' }).then((response) => {
        if (!response.ok) throw new Error('No se pudo cargar el flujo.');
        return response.json();
      }).then((data) => { flow = data.flow; renderNodes(); }).catch((error) => {
        editor.innerHTML = '<div class="flow-editor-empty"><strong>Error al cargar</strong><small>' + escapeText(error.message) + '</small></div>';
      });
    })();
  </script>
</body>
</html>`;
}

// ─── Webhook verification ─────────────────────────────────────────────────────
app.get("/webhook", (req, res) => {
  console.log("✅ Webhook verification request received");
  // Support Meta-style challenge
  const challenge = req.query["hub.challenge"];
  if (challenge) return res.send(challenge);
  res.status(200).json({ status: "ok" });
});

app.get("/media/audios/:file", (req, res) => {
  const file = String(req.params.file ?? "");
  const allowed = new Set(Object.values(FLOW_AUDIOS).flatMap((audio) => [audio.voiceFile, audio.audioFile]));

  if (!allowed.has(file)) return res.sendStatus(404);

  res.type(file.endsWith(".mp3") ? "audio/mpeg" : "audio/ogg");
  res.sendFile(path.join(AUDIO_DIR, file));
});

app.get("/media/contenidofantasia.mp4", (_, res) => {
  res.type("video/mp4");
  res.sendFile(FANTASIA_VIDEO_PATH);
});

// ─── Admin handoff panel ──────────────────────────────────────────────────────
app.get("/admin", requireAdmin, async (req, res) => {
  const section = activeAdminSection(req);
  const selectedDate = localDateKey(parseDateKey(req.query.date ?? localDateKey()));
  const forceRefresh = String(req.query.refresh ?? "") === "1";
  let metaAdsMetrics = null;
  let adsDashboard = null;

  if (section === "dashboard") {
    metaAdsMetrics = getMetaAdsDailyMetrics(selectedDate, primaryMetaAdAccountId());
    if (forceRefresh) {
      [metaAdsMetrics] = await Promise.all([
        refreshMetaAdsMetrics(selectedDate, { force: true }),
        refreshLegacyMetaAdsMetrics(),
      ]);
    }
    else void Promise.all([
      refreshLegacyMetaAdsMetrics(),
      refreshMetaAdsMetricsRange(shiftDateKey(selectedDate, -6), selectedDate),
    ])
      .catch((err) => console.warn("⚠️ Meta Ads dashboard backfill failed:", err.message));
  }
  if (section === "income") {
    const requestedFrom = String(req.query.from ?? "");
    const requestedTo = String(req.query.to ?? "");
    const fromDate = isValidDateKey(requestedFrom) ? requestedFrom : shiftDateKey(localDateKey(), -6);
    const toDate = isValidDateKey(requestedTo) ? requestedTo : localDateKey();
    if (forceRefresh) {
      await Promise.all([
        refreshMetaAdsMetricsRange(fromDate, toDate, { force: true }),
        refreshLegacyMetaAdsMetrics(),
      ]);
    }
    else void Promise.all([
      refreshLegacyMetaAdsMetrics(),
      refreshMetaAdsMetricsRange(fromDate, toDate),
    ])
      .catch((err) => console.warn("⚠️ Meta Ads income backfill failed:", err.message));
  }
  if (section === "ads") adsDashboard = await cachedAdsDashboard(req, { force: forceRefresh });
  if (shouldRunCtwaBackfill({ query: req.query, env: process.env })) {
    const explicitlyRequested = ["1", "true"].includes(String(req.query.ctwaBackfill ?? req.query.ctwa_backfill ?? "").toLowerCase());
    if (!ctwaBackfillRequest && (explicitlyRequested || Date.now() - lastCtwaBackfillAt >= 300_000)) {
      lastCtwaBackfillAt = Date.now();
      ctwaBackfillRequest = backfillCtwaAttribution({ limit: 100, maxPages: explicitlyRequested ? 50 : 1 })
        .catch((err) => console.warn("⚠️ CTWA backfill failed:", err.message))
        .finally(() => { ctwaBackfillRequest = null; });
    }
  }

  res.send(renderAdminPage(req, { adsDashboard, metaAdsMetrics }));
});

app.get("/admin/api/revision", requireAdmin, (_, res) => {
  res.json(getAdminRevision(localDateKey()));
});

app.post("/admin/ctwa-backfill", requireAdmin, async (req, res) => {
  if (ctwaBackfillRequest) {
    return res.redirect(303, adminPath(req, { status: "ctwa_backfill_partial", section: req.body.section ?? "ads", ctwaErrors: 1 }));
  }

  const request = backfillCtwaAttribution({ limit: 100, maxPages: 50 });
  ctwaBackfillRequest = request.finally(() => { ctwaBackfillRequest = null; });

  try {
    const result = await ctwaBackfillRequest;
    return res.redirect(303, adminPath(req, {
      status: result.errors.length ? "ctwa_backfill_partial" : "ctwa_backfill_completed",
      section: req.body.section ?? "ads",
      ctwaPages: result.pages,
      ctwaConversations: result.conversations,
      ctwaAttributed: result.attributed,
      ctwaErrors: result.errors.length,
    }));
  } catch (err) {
    console.warn("⚠️ CTWA attribution backfill failed:", err.message);
    return res.redirect(303, adminPath(req, { status: "ctwa_backfill_partial", section: req.body.section ?? "ads", ctwaErrors: 1 }));
  }
});

app.get("/admin/api/performance", requireAdmin, (_, res) => {
  res.json({ ...performanceSnapshot(), caches: { ads: adsDashboardCache.stats() } });
});

app.get("/admin/api/handoffs", requireAdmin, (req, res) => {
  const pageSize = 50;
  const page = Math.max(1, Number.parseInt(req.query.page ?? "1", 10) || 1);
  const query = adminConversationQuery(req);
  const total = countConversationSummaries(query);
  const revision = getAdminRevision();
  res.json({
    handoffs: listHumanHandoffs(),
    conversations: listConversationSummaries({ ...query, limit: pageSize, offset: (page - 1) * pageSize }),
    payments: listPayments({ limit: pageSize, offset: (page - 1) * pageSize }),
    pagination: { page, pageSize, conversationTotal: total, paymentTotal: revision.payments },
  });
});

app.get("/admin/api/flow", requireAdmin, (_, res) => {
  res.json({ flow: buildConversationFlow(getSettings()) });
});

app.patch("/admin/api/flow", requireAdmin, (req, res) => {
  const result = validateFlowSettings(req.body?.settings);
  if (!result.ok) return res.status(400).json({ error: result.error });

  updateSettings(result.updates);
  return res.json({ flow: buildConversationFlow(getSettings()) });
});

app.post("/admin/handoffs", requireAdmin, (req, res) => {
  const phoneNumber = String(req.body.phoneNumber ?? "").trim();

  if (phoneNumber) {
    requestHumanHandoff(phoneNumber, {
      reason: String(req.body.reason ?? "manual_handoff").trim() || "manual_handoff",
      lastMessage: "Pausado manualmente desde panel",
    });
  }

  res.redirect(303, adminPath(req, { status: "bot_paused", section: "conversations" }));
});

app.post("/admin/handoffs/:phoneNumber/resolve", requireAdmin, (req, res) => {
  resolveHumanHandoff(req.params.phoneNumber);
  res.redirect(303, adminPath(req, { status: "bot_resolved", section: "conversations" }));
});

app.post("/admin/handoffs/resolve-all", requireAdmin, (req, res) => {
  for (const handoff of listHumanHandoffs()) {
    resolveHumanHandoff(handoff.phoneNumber);
  }

  res.redirect(303, adminPath(req, { status: "bot_all_resolved", section: "conversations" }));
});

async function sendManualOffer(req, res, settingKey, successStatus) {
  const phoneNumber = req.params.phoneNumber;
  const contact = getContact(phoneNumber);

  if (!contact.conversation_id) {
    return res.redirect(303, adminPath(req, { status: "release_no_conversation" }));
  }

  const promoText = buildManualOfferText(settingKey);
  if (!promoText) {
    return res.redirect(303, adminPath(req, { status: "settings_saved", section: "settings" }));
  }

  try {
    await sendWhatsAppMessage(contact.conversation_id, promoText, zernioOptionsFor(contact, { allowHumanAgentTag: true }));
    addMessage(phoneNumber, "assistant", promoText, { conversationId: contact.conversation_id });
    markManualOfferSent(phoneNumber);
    res.redirect(303, adminPath(req, { status: successStatus }));
  } catch (err) {
    console.error(`❌ Error sending manual offer to ${phoneNumber}:`, err.message);
    res.redirect(303, adminPath(req, { status: "promo_send_failed" }));
  }
}

async function runAdminContactOperation(res, operation) {
  const result = await trackContactOperation(operation);
  if (result === false && !res.headersSent) res.status(503).send("Contact history maintenance in progress.");
}

app.post("/admin/contacts/:phoneNumber/offer-flash", requireAdmin, async (req, res) => {
  await runAdminContactOperation(res, () => sendManualOffer(req, res, "flash_offer_text", "flash_offered"));
});

async function processManualPayment(req, res) {
  const phoneNumber = req.params.phoneNumber;
  const product = PAYMENT_PRODUCTS[String(req.body.productCode ?? "fantasia")] ?? PAYMENT_PRODUCTS.fantasia;
  const amount = req.body.amount ? parseMoney(req.body.amount, product.amount) : product.amount;
  const discount = req.body.discount ? parseMoney(req.body.discount, product.discount) : product.discount;
  const contactBeforePayment = getContact(phoneNumber);

  const paymentId = recordPayment(phoneNumber, {
    conversationId: contactBeforePayment.conversation_id,
    productCode: product.code,
    productName: product.name,
    amount,
    discount,
    note: req.body.note ?? "",
  });
  queueCtwaAttributionRecovery(phoneNumber, contactBeforePayment);
  trackContactOperation(() => sendPurchaseConversionForPayment(paymentId, phoneNumber, {
    conversationId: contactBeforePayment.conversation_id,
    amount,
    contact: contactBeforePayment,
  })).catch((err) => {
    console.warn(`⚠️ Meta conversion background task failed for ${phoneNumber}:`, err.message);
  });

  const contact = getContact(phoneNumber);
  let status = "paid_link_sent";

  if (!contact.conversation_id) {
    status = "paid_no_conversation";
  } else if (contact.product_link_sent) {
    status = "paid_already_sent";
  } else {
    const deliveryText = buildProductDeliveryText();

    try {
      await sendWhatsAppMessage(contact.conversation_id, deliveryText, zernioOptionsFor(contact, { allowHumanAgentTag: true }));
      addMessage(phoneNumber, "assistant", deliveryText, { conversationId: contact.conversation_id });
      markProductLinkSent(phoneNumber);
    } catch (err) {
      status = "paid_send_failed";
      console.error(`❌ Error sending product link to ${phoneNumber}:`, err.message);
    }
  }

  res.redirect(303, adminPath(req, { status, section: "conversations" }));
}

app.post("/admin/contacts/:phoneNumber/paid", requireAdmin, async (req, res) => {
  await runAdminContactOperation(res, () => processManualPayment(req, res));
});

app.post("/admin/contacts/:phoneNumber/unpaid", requireAdmin, (req, res) => {
  markContactPaid(req.params.phoneNumber, false);
  res.redirect(303, adminPath(req, { status: "unpaid", section: "conversations" }));
});

app.post("/admin/contacts/:phoneNumber/revert-conversion", requireAdmin, (req, res) => {
  const reversal = reverseLatestPayment(req.params.phoneNumber);
  res.redirect(303, adminPath(req, {
    status: reversal ? "conversion_reverted" : "conversion_revert_missing",
    section: req.body.section ?? "dashboard",
  }));
});

app.get("/admin/contacts.csv", requireSensitiveAdmin, (_, res) => {
  const csv = contactHistoryCsv(listContactHistoryForExport());
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="contactos-${localDateKey()}.csv"`);
  res.send(csv);
});

app.post("/admin/contacts/purge", requireSensitiveAdmin, async (req, res) => {
  if (String(req.body.confirmation ?? "").trim() !== "BORRAR TODO") {
    return res.redirect(303, adminPath(req, { status: "contacts_purge_failed", section: "conversations" }));
  }

  contactHistoryMaintenance = true;
  try {
    clearContactRuntimeState();
    await waitForContactOperations();
    clearContactRuntimeState();
    const deleted = purgeContactHistory();
    console.warn(JSON.stringify({ event: "contact_history_purged", ...deleted }));
    return res.redirect(303, adminPath(req, { status: "contacts_purged", section: "conversations" }));
  } finally {
    contactHistoryMaintenance = false;
    resumeDeferredWebhookEvents();
  }
});

app.post("/admin/contacts/:phoneNumber/delete", requireAdmin, (req, res) => {
  deleteContact(req.params.phoneNumber);
  res.redirect(303, adminPath(req, { status: "contact_deleted", section: "conversations" }));
});

app.post("/admin/contacts/:phoneNumber/trigger-flow", requireAdmin, async (req, res) => {
  const phoneNumber = req.params.phoneNumber;
  const contact = getContact(phoneNumber);
  if (!contact) {
    return res.redirect(303, adminPath(req, { status: "trigger_flow_no_contact", section: req.body.section ?? "conversations" }));
  }

  const fakeBody = {
    message: {
      text: "info",
      direction: "incoming",
      sender: { phoneNumber },
    },
    conversation: {
      id: contact.conversation_id,
      contact: { phoneNumber },
    },
    account: { id: contact.account_id },
  };

  processIncomingMessage({ req, body: fakeBody, isLocalTest: false }).catch((err) => {
    console.error(`❌ Error en trigger-flow para ${phoneNumber}:`, err.message);
  });

  res.redirect(303, adminPath(req, { status: "trigger_flow_started", section: req.body.section ?? "conversations" }));
});

app.post("/admin/ad-spend", requireAdmin, (req, res) => {
  const date = String(req.body.date ?? req.query.date ?? "");
  if (!isValidDateKey(date)) return res.status(400).send("Invalid date");
  const usdArsRate = Math.max(1, parseMoney(req.body.usd_ars_rate, 1500));
  upsertAdSpend(date, {
    amount: parseMoney(req.body.amount, 0),
    note: req.body.note ?? "",
  });
  updateSettings({ usd_ars_rate: String(usdArsRate) });

  res.redirect(303, adminPath(req, { status: "ad_spend_saved", section: "dashboard", date }));
});

app.post("/admin/revenue-adjustment", requireAdmin, (req, res) => {
  const date = String(req.body.date ?? req.query.date ?? "");
  if (!isValidDateKey(date)) return res.status(400).send("Invalid date");
  const amount = parseSignedMoney(req.body.amount, 0);
  const note = String(req.body.note ?? "").trim();
  const confirmed = req.body.confirm === "yes";
  const phrase = String(req.body.phrase ?? "").trim();
  const systemRevenue = sumMoney(listPayments({ from: date, to: date }));
  const finalRevenue = systemRevenue + amount;

  if (!confirmed || phrase !== "AJUSTAR" || !note || finalRevenue < 0) {
    return res.redirect(303, adminPath(req, { status: "revenue_adjust_failed", section: "dashboard", date }));
  }

  upsertRevenueAdjustment(date, { amount, note });
  res.redirect(303, adminPath(req, { status: "revenue_adjusted", section: "dashboard", date }));
});

app.post("/admin/settings", requireAdmin, (req, res) => {
  updateSettings({
    master_prompt: req.body.master_prompt ?? "",
    next_reply_prompt: req.body.next_reply_prompt ?? "",
    paid_reply_prompt: req.body.paid_reply_prompt ?? "",
    initial_offer_text: String(req.body.initial_offer_text ?? "").trim() || getSetting("initial_offer_text"),
    product_landing_text: String(req.body.product_landing_text ?? "").trim() || getSetting("product_landing_text"),
    product_landing_url: String(req.body.product_landing_url ?? "").trim() || getSetting("product_landing_url"),
    payment_alias: String(req.body.payment_alias ?? "").trim() || getSetting("payment_alias"),
    payment_alias_note: String(req.body.payment_alias_note ?? "").trim() || getSetting("payment_alias_note"),
    payment_instructions_text: String(req.body.payment_instructions_text ?? "").trim() || getSetting("payment_instructions_text"),
    reminder2_offer_text: req.body.reminder2_offer_text ?? "",
    exclusive_offer_text: String(req.body.exclusive_offer_text ?? "").trim() || getSetting("exclusive_offer_text"),
    final_discount_text: String(req.body.final_discount_text ?? "").trim() || getSetting("final_discount_text"),
    ask_name_text: req.body.ask_name_text ?? "",
    flash_offer_text: req.body.flash_offer_text ?? "",
    product_access_url: req.body.product_access_url ?? "",
    product_delivery_text: req.body.product_delivery_text ?? "",
    meta_ads_destination_id: req.body.meta_ads_destination_id ?? "",
    usd_ars_rate: getSetting("usd_ars_rate", "1500"),
    openai_max_tokens: req.body.openai_max_tokens ?? "180",
  });

  res.redirect(303, adminPath(req, { status: "settings_saved", section: "settings" }));
});

// ─── Incoming inbox messages ──────────────────────────────────────────────────

async function processIncomingMessageImpl({ req, body, isLocalTest }) {
  const { message, conversation } = body;
  const identity = getWebhookIdentity(body);
  const conversationId = identity.conversationId;
  const phoneNumber = identity.contactId;
  const channel = identity.channel;
  const ctwaAttribution = extractCtwaAttribution(body);
  let userMessage = getIncomingText(message).trim();

  if (!phoneNumber) {
    console.error("❌ Incoming message without contact identity:", JSON.stringify(body));
    return;
  }

  if (!userMessage && hasAudioAttachment(message)) {
    const audioUrl = getAudioAttachmentUrl(message);
    if (audioUrl) {
      try {
        console.log(`🎙️ Transcribing audio from ${phoneNumber}`);
        userMessage = await transcribeAudioFromUrl(audioUrl);
        console.log(`📝 [${phoneNumber}] ${userMessage}`);
      } catch (transcriptionErr) {
        console.error(`❌ Error transcribing audio from ${phoneNumber}:`, transcriptionErr.message);
      }
    } else {
      console.warn(`⚠️ Audio received without downloadable URL from ${phoneNumber}`);
    }
  }

  if (!userMessage && !hasAttachment(message)) return;

  console.log(`📨 [${channel}:${phoneNumber}] ${userMessage || "[attachment]"}`);

  if (ctwaAttribution) {
    saveContactCtwaAttribution(phoneNumber, {
      ...ctwaAttribution,
      conversationId,
      accountId: identity.accountId,
      conversationUrl: identity.conversationUrl,
    });
  }

  const reply = async (text) => {
    if (!isLocalTest) {
      try {
        await sendTypingIndicator(conversationId, zernioOptionsFor(identity));
      } catch (typingErr) {
        console.warn(`⚠️ Typing indicator failed for ${phoneNumber}:`, typingErr.message);
      }
    }

    await sleep(humanDelayFor(text));

    if (isLocalTest) {
      console.log(`🧪 Local test reply: ${text}`);
      return;
    }

    await sendWhatsAppMessage(conversationId, text, zernioOptionsFor(identity));
  };

  let initialOfferClaimed = false;
  let secondBatchClaimed = false;
  let exclusiveOfferClaimed = false;
  let finishSecondBatch = null;
  try {
    if (userMessage.trim() === "/clear") {
      clearHistory(phoneNumber);
      await reply("Listo, arranquemos de nuevo 🙂\nQuerés que te pase la info de *Fantasía Color PRO*?");
      return;
    }

    if (userMessage.trim() === "/help") {
      const helpText =
        "*Ofiprof - Fantasía Color PRO* ✨\n" +
        "Te puedo pasar información del pack, contenido, precio y forma de pago. Comandos: /clear reinicia la charla y /help muestra esta ayuda.";
      await reply(helpText);
      return;
    }

    const contact = getContact(phoneNumber, identity);
    let history = getHistory(phoneNumber);
    let messageForAI = userMessage || "[archivo adjunto]";
    const awaitingExclusiveOfferResponse = shouldActivateExclusiveOffer(contact, userMessage);
    const exclusiveOfferPending =
      !contact.paid &&
      contact.exclusive_offer_accepted_at &&
      (!contact.exclusive_offer_text_sent || !contact.exclusive_alias_note_sent || !contact.exclusive_alias_sent);
    const secondBatchPending =
      !contact.paid &&
      hasGreetingBeenSent(phoneNumber) &&
      (!hasFantasiaVideoBeenSent(phoneNumber) ||
        !hasPaymentAliasBeenSent(phoneNumber) ||
        !hasPaymentAliasNoteBeenSent(phoneNumber) ||
        !hasPaymentInstructionsBeenSent(phoneNumber));

    if (hasAudioAttachment(message) && !userMessage) {
      addMessage(phoneNumber, "user", "[audio recibido]", { conversationId });

      const audioText =
        "Te soy sincero: para no interpretarte mal, prefiero que me lo mandes escrito por acá 🙏\n" +
        "Así te respondo bien sobre *Fantasía Color PRO* y no se pierde nada.";

      await reply(audioText);
      return;
    }

    if (getAttachmentKinds(message).includes("sticker")) {
      console.log(`🏷️ [${phoneNumber}] Sticker received, ignoring.`);
      return;
    }

    if (isEmojiOnly(userMessage) && !secondBatchPending && !awaitingExclusiveOfferResponse && !exclusiveOfferPending) {
      console.log(`🏷️ [${phoneNumber}] Emoji-only message, ignoring.`);
      return;
    }

    const hasPaymentContext = hasCommercialPaymentContext(
      contact,
      history,
      hasPaymentAliasBeenSent(phoneNumber) || Boolean(contact.exclusive_alias_sent)
    );
    const isContextualPaymentAttachment = hasPaymentAttachment(message) && hasPaymentContext;

    if (!contact.paid && isContextualPaymentAttachment) {
      addMessage(phoneNumber, "user", userMessage || "[comprobante adjunto]", { conversationId });
      const imageUrl = getPaymentImageAttachmentUrl(message);
      const proofDetails = await extractAndSavePaymentName(phoneNumber, userMessage, imageUrl);
      if (!shouldAutoProcessPaymentAttachment(hasPaymentContext, proofDetails)) {
        requestHumanHandoff(phoneNumber, {
          reason: "unverified_payment_attachment",
          lastMessage: userMessage || "[adjunto sin comprobante confirmado]",
          conversationId,
        });
        await reply("No pude confirmar automáticamente que el archivo sea un comprobante. Lo dejamos para revisión antes de habilitar el acceso.");
        console.warn(`⚠️ Unverified payment attachment sent to review for ${phoneNumber}`);
        return;
      }
      const product = PAYMENT_PRODUCTS.fantasia;
      const offeredAmount = contact.final_discount_sent_at ? 6999 : contact.exclusive_offer_text_sent ? 9999 : product.amount;
      const amount = proofDetails.amount > 0 ? proofDetails.amount : offeredAmount;
      const discount = Math.max(0, product.amount - amount);
      const wasAccessAlreadySent = Boolean(contact.product_link_sent);

      const paymentId = recordPayment(phoneNumber, {
        conversationId,
        productCode: product.code,
        productName: product.name,
        amount,
        discount,
        note: proofDetails.isPaymentProof ? "Comprobante detectado automaticamente" : "Comprobante registrado automaticamente",
      });
      queueCtwaAttributionRecovery(phoneNumber, contact);
      trackContactOperation(() => sendPurchaseConversionForPayment(paymentId, phoneNumber, { conversationId, amount, contact })).catch((err) => {
        console.warn(`⚠️ Meta conversion background task failed for ${phoneNumber}:`, err.message);
      });

      const deliveryText = buildPaidProofDeliveryText(wasAccessAlreadySent);
      addMessage(phoneNumber, "assistant", deliveryText, { conversationId });
      await reply(deliveryText);
      markProductLinkSent(phoneNumber);

      console.log(`💰 Payment proof auto-processed for ${phoneNumber}: ${amount}`);
      return;
    }

    if (hasPaymentAttachment(message) && !userMessage) {
      console.log(`📎 [${phoneNumber}] Non-payment attachment received, ignoring.`);
      return;
    }

    if (isHumanHandoffRequested(phoneNumber)) {
      addMessage(phoneNumber, "user", userMessage || "[mensaje durante handoff]", { conversationId });
      requestHumanHandoff(phoneNumber, { lastMessage: userMessage || "[mensaje durante handoff]", conversationId });
      console.log(`🧑‍💼 Human handoff already requested for ${phoneNumber}. Automation skipped.`);
      return;
    }

    if (contact.paid && !contact.product_link_sent) {
      addMessage(phoneNumber, "user", messageForAI, { conversationId });
      const deliveryText = buildProductDeliveryText();
      await reply(deliveryText);
      addMessage(phoneNumber, "assistant", deliveryText, { conversationId });
      markProductLinkSent(phoneNumber);
      console.log(`📦 Pending product access delivered to ${phoneNumber}`);
      return;
    }

    const acceptedExclusiveOffer = awaitingExclusiveOfferResponse;

    if (acceptedExclusiveOffer || exclusiveOfferPending) {
      addMessage(phoneNumber, "user", messageForAI, { conversationId });
      if (acceptedExclusiveOffer) {
        acceptExclusiveOfferResponse(phoneNumber);
      }
      if (!claimExclusiveOffer(phoneNumber)) {
        console.log(`⏭️ Exclusive offer already claimed or completed for ${phoneNumber}`);
        return;
      }
      exclusiveOfferClaimed = true;
      const freshContact = getContact(phoneNumber);

      if (!freshContact.exclusive_offer_text_sent) {
        const exclusiveText = getSetting("exclusive_offer_text", "").trim();
        if (!exclusiveText) throw new Error("exclusive_offer_text is empty");
        await reply(exclusiveText);
        addMessage(phoneNumber, "assistant", exclusiveText, { conversationId });
        markExclusiveOfferTextSent(phoneNumber);
      }
      if (!freshContact.exclusive_alias_note_sent) {
        const aliasNote = getSetting("payment_alias_note", "").trim();
        if (!aliasNote) throw new Error("payment_alias_note is empty");
        await sleep(900);
        await reply(aliasNote);
        addMessage(phoneNumber, "assistant", aliasNote, { conversationId });
        markExclusiveAliasNoteSent(phoneNumber);
      }
      if (!freshContact.exclusive_alias_sent) {
        const alias = getSetting("payment_alias", "").trim();
        if (!alias) throw new Error("payment_alias is empty");
        await sleep(900);
        await reply(alias);
        addMessage(phoneNumber, "assistant", alias, { conversationId });
        const finalAt = markExclusiveAliasSent(phoneNumber);
        if (finalAt) console.log(`⏰ Final $6.999 discount scheduled for ${phoneNumber}: ${finalAt}`);
      }
      releaseExclusiveOffer(phoneNumber);
      exclusiveOfferClaimed = false;
      return;
    }

    if (!contact.paid && !hasGreetingBeenSent(phoneNumber)) {
      if (!claimInitialOffer(phoneNumber)) {
        console.log(`⏭️ Initial offer already claimed for ${phoneNumber}`);
        return;
      }
      initialOfferClaimed = true;

      addMessage(phoneNumber, "user", messageForAI, { conversationId });
      const scheduledAt = scheduleDownsell(phoneNumber, conversationId);
      if (scheduledAt) {
        console.log(`⏰ 23h reminder scheduled for ${phoneNumber}: ${scheduledAt}`);
      }

      const greetingSent = await sendGreetingAudio(req, conversationId, phoneNumber, isLocalTest, identity);
      if (!greetingSent) throw new Error("Fantasía greeting audio could not be sent");
      await sleep(700);

      const offerText = getSetting("initial_offer_text", "").trim();
      const offerChunks = initialOfferTextChunks(offerText, channel);
      if (!offerChunks.length) throw new Error("initial_offer_text is empty");

      for (const chunk of offerChunks) {
        await reply(chunk);
        addMessage(phoneNumber, "assistant", chunk, { conversationId });
      }

      const landingText = buildProductLandingText().trim();
      if (landingText) {
        await sleep(900);
        await reply(landingText);
        addMessage(phoneNumber, "assistant", landingText, { conversationId });
      }
      initialOfferClaimed = false;
      return;
    }

    if (!contact.paid && hasGreetingBeenSent(phoneNumber) && !hasGreetingAudioBeenSent(phoneNumber)) {
      const greetingSent = await sendGreetingAudio(req, conversationId, phoneNumber, isLocalTest, identity);
      if (!greetingSent) throw new Error("Fantasía greeting audio retry could not be sent");
      await sleep(700);
    }

    if (secondBatchPending) {
      if (!claimSecondResponseBatch(phoneNumber)) {
        console.log(`⏭️ Second-response batch already claimed for ${phoneNumber}`);
        const pendingBatch = pendingSecondResponseBatches.get(phoneNumber);
        if (pendingBatch) {
          const completed = await pendingBatch;
          if (!completed) return processIncomingMessageImpl({ req, body, isLocalTest });
          history = getHistory(phoneNumber);
        }
      } else {
        secondBatchClaimed = true;
        let resolveBatch;
        const batchPromise = new Promise((resolve) => { resolveBatch = resolve; });
        pendingSecondResponseBatches.set(phoneNumber, batchPromise);
        finishSecondBatch = (completed) => {
          resolveBatch(completed);
          if (pendingSecondResponseBatches.get(phoneNumber) === batchPromise) {
            pendingSecondResponseBatches.delete(phoneNumber);
          }
        };
        addMessage(phoneNumber, "user", messageForAI, { conversationId });

        if (!hasFantasiaVideoBeenSent(phoneNumber)) {
          const videoSent = await sendFantasiaVideo(req, conversationId, phoneNumber, isLocalTest, identity);
          if (!videoSent) throw new Error("Fantasía video could not be sent");
          addMessage(phoneNumber, "assistant", "[video Fantasía Color PRO]", { conversationId });
          markFantasiaVideoSent(phoneNumber);
        }

        if (!hasPaymentAliasNoteBeenSent(phoneNumber)) {
          const aliasNote = getSetting("payment_alias_note", "").trim();
          if (!aliasNote) throw new Error("payment_alias_note is empty");
          await sleep(900);
          await reply(aliasNote);
          addMessage(phoneNumber, "assistant", aliasNote, { conversationId });
          markPaymentAliasNoteSent(phoneNumber);
        }

        if (!hasPaymentAliasBeenSent(phoneNumber)) {
          const paymentAlias = getSetting("payment_alias", "").trim();
          if (!paymentAlias) throw new Error("payment_alias is empty");
          await sleep(900);
          await reply(paymentAlias);
          addMessage(phoneNumber, "assistant", paymentAlias, { conversationId });
          markPaymentAliasSent(phoneNumber);
        }

        if (!hasPaymentInstructionsBeenSent(phoneNumber)) {
          const paymentInstructions = getSetting("payment_instructions_text", "").trim();
          if (!paymentInstructions) throw new Error("payment_instructions_text is empty");
          await sleep(900);
          await reply(paymentInstructions);
          addMessage(phoneNumber, "assistant", paymentInstructions, { conversationId });
          markPaymentInstructionsSent(phoneNumber);
        }
        releaseSecondResponseBatch(phoneNumber);
        secondBatchClaimed = false;
        finishSecondBatch(true);
        finishSecondBatch = null;
        return;
      }
    }

    const isPriceInquiry = looksLikePriceInquiry(messageForAI);

    const aiReply = await getAIResponse(phoneNumber, messageForAI, history, {
      isPaidContact: Boolean(contact.paid),
      isPriceInquiry,
    });

    addMessage(phoneNumber, "user", messageForAI, { conversationId });
    addMessage(phoneNumber, "assistant", aiReply, { conversationId });
    await reply(aiReply);

    console.log(`🤖 [${phoneNumber}] ${aiReply.slice(0, 80)}...`);
  } catch (err) {
    if (initialOfferClaimed) releaseInitialOfferClaim(phoneNumber);
    if (secondBatchClaimed) releaseSecondResponseBatch(phoneNumber);
    if (exclusiveOfferClaimed) releaseExclusiveOffer(phoneNumber);
    console.error(`❌ Error handling message from ${phoneNumber}:`, err.message);
    try {
      await reply("Perdón, tuve un problema para responder. Probá escribirme de nuevo en un momento 🙏");
    } catch (sendErr) {
      console.error(`❌ Error sending failure message to ${phoneNumber}:`, sendErr.message);
    }
    finishSecondBatch?.(false);
  }
}

function processIncomingMessage(options) {
  return trackContactOperation(() => processIncomingMessageImpl(options));
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

function scheduleDebouncedMessage({ req, body, isLocalTest }) {
  const identity = getWebhookIdentity(body);
  const key = getDebounceKey(identity);
  const text = getIncomingText(body.message).trim();

  const existing = pendingMessages.get(key);
  if (existing) {
    existing.texts.push(text);
    clearTimeout(existing.timer);
  } else {
    pendingMessages.set(key, { req, body, isLocalTest, identity, texts: [text] });
  }

  const entry = pendingMessages.get(key);
  entry.timer = setTimeout(async () => {
    pendingMessages.delete(key);
    const mergedBody = { ...entry.body, message: { ...entry.body.message, text: entry.texts.join("\n") } };
    await processIncomingMessage({ req: entry.req, body: mergedBody, isLocalTest: entry.isLocalTest });
  }, MESSAGE_DEBOUNCE_MS);

  console.log(`⏳ [${key}] Debouncing ${entry.texts.length} message(s), waiting ${MESSAGE_DEBOUNCE_MS}ms`);
}

function captureConversationStarted(body) {
  const identity = getWebhookIdentity(body);
  const attribution = extractCtwaAttribution(body);
  if (identity.contactId && attribution) {
    saveContactCtwaAttribution(identity.contactId, {
      ...attribution,
      channel: identity.channel,
      conversationId: identity.conversationId,
      accountId: identity.accountId,
      externalId: identity.externalId,
      displayHandle: identity.displayHandle,
      name: identity.name,
      conversationUrl: identity.conversationUrl,
    });
  }
}

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  const isLocalTest = req.get("x-local-test") === "true";
  const { event, message, conversation } = req.body;

  if (event === "message.failed") {
    const failedMessageId = String(message?.id ?? message?.messageId ?? "");
    const error = message?.error ?? req.body.error ?? {};
    console.error(
      "❌ Zernio message.failed:",
      JSON.stringify({
        conversationId: message?.conversationId ?? conversation?.id,
        messageId: message?.id ?? message?.messageId,
        platformMessageId: message?.platformMessageId,
        attachmentType: message?.attachmentType,
        text: message?.text ?? message?.message,
        error,
      })
    );

    const persistedFallback = failedMessageId ? getGreetingAudioFallback(failedMessageId) : null;
    const fallback = (failedMessageId ? pendingAudioFallbacks.get(failedMessageId) : null) ?? (persistedFallback ? {
      req,
      conversationId: persistedFallback.conversation_id,
      phoneNumber: persistedFallback.phone_number,
      audioKey: "greeting",
      options: persistedFallback,
    } : null);
    if (fallback) {
      pendingAudioFallbacks.delete(failedMessageId);
      try {
        const fallbackSent = await sendFlowAudioFallback(
          fallback.req,
          fallback.conversationId,
          fallback.phoneNumber,
          fallback.audioKey,
          false,
          fallback.options,
          `async message.failed ${failedMessageId}`
        );
        if (!fallbackSent) throw new Error("Fallback media could not be sent");
        markGreetingAudioSent(fallback.phoneNumber);
      } catch (fallbackErr) {
        markGreetingAudioFailed(fallback.phoneNumber, failedMessageId);
        console.error(`❌ Audio fallback failed after message.failed ${failedMessageId}:`, fallbackErr.message);
      }
    }
    return;
  }

  if (event === "conversation.started") {
    if (contactHistoryMaintenance) deferredWebhookEvents.push({ req, body: req.body, isLocalTest });
    else captureConversationStarted(req.body);
    return;
  }

  if (event !== "message.received" || message?.direction !== "incoming") return;

  if (contactHistoryMaintenance) {
    deferredWebhookEvents.push({ req, body: req.body, isLocalTest });
    return;
  }

  if (shouldDebounceMessage(req.body)) {
    scheduleDebouncedMessage({ req, body: req.body, isLocalTest });
    return;
  }

  await processIncomingMessage({ req, body: req.body, isLocalTest });
});

// ─── Root and health ────────────────────────────────────────────────────────
app.get("/", (_, res) => {
  const token = process.env.ADMIN_TOKEN;
  const target = token ? `/admin?token=${encodeURIComponent(token)}` : "/admin";
  res.redirect(target);
});

app.get("/health", (_, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

setInterval(() => {
  Promise.all([processDueDownsells(), processDueFinalDiscounts()]).catch((err) => {
    console.error("❌ Reminder worker error:", err.message);
  });
}, 30_000);

setTimeout(() => {
  Promise.all([processDueDownsells(), processDueFinalDiscounts()]).catch((err) => {
    console.error("❌ Reminder worker error:", err.message);
  });
}, 5_000);

setTimeout(queueRecentCtwaAttributionRecovery, 10_000);

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT ?? 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 WhatsApp AI Agent running on port ${PORT}`);
  console.log(`   Webhook: http://localhost:${PORT}/webhook`);
  console.log(`   Health:  http://localhost:${PORT}/health\n`);
});
