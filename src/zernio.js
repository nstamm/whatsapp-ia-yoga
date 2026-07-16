import { measureAsync } from "./performanceMetrics.js";

const BASE_URL = "https://zernio.com/api/v1";
const DEFAULT_REQUEST_TIMEOUT_MS = 12_000;

function requestTimeoutMs() {
  const configured = Number.parseInt(process.env.ZERNIO_REQUEST_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_REQUEST_TIMEOUT_MS;
}

function zernioMetricName(url) {
  const pathname = new URL(url).pathname
    .replace(/\/inbox\/conversations\/[^/]+/i, "/inbox/conversations/:id")
    .replace(/\/[0-9a-f-]{16,}/gi, "/:id");
  return `provider.zernio.${pathname}`;
}

function zernioFetch(url, options = {}) {
  return measureAsync(zernioMetricName(url), () => fetch(url, {
    ...options,
    signal: options.signal ?? AbortSignal.timeout(requestTimeoutMs()),
  }));
}

const headers = () => ({
  Authorization: `Bearer ${process.env.ZERNIO_API_KEY}`,
  "Content-Type": "application/json",
});

function accountIdFrom(options = {}) {
  return options.accountId || process.env.ZERNIO_ACCOUNT_ID;
}

export async function sendWhatsAppMessage(conversationId, text, options = {}) {
  const payload = { message: text };
  if (options.messagingType) payload.messagingType = options.messagingType;
  if (options.messageTag) payload.messageTag = options.messageTag;
  return sendConversationMessage(conversationId, payload, options);
}

export async function sendWhatsAppMedia(conversationId, attachmentUrl, attachmentType, options = {}) {
  const payload = {
    attachmentUrl,
    attachmentType,
  };

  if (options.voiceNote === true) payload.voiceNote = true;
  if (options.message) payload.message = options.message;
  if (options.messagingType) payload.messagingType = options.messagingType;
  if (options.messageTag) payload.messageTag = options.messageTag;

  return sendConversationMessage(conversationId, payload, options);
}

export async function sendTypingIndicator(conversationId, options = {}) {
  const accountId = accountIdFrom(options);

  if (!process.env.ZERNIO_API_KEY) {
    throw new Error("ZERNIO_API_KEY is missing. Complete it in your .env file.");
  }

  if (!accountId) {
    throw new Error("ZERNIO_ACCOUNT_ID is missing. Complete it in your .env file.");
  }

  if (!conversationId) {
    throw new Error("conversationId is missing from the Zernio webhook payload.");
  }

  const url = `${BASE_URL}/inbox/conversations/${conversationId}/typing`;

  const res = await zernioFetch(url, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ accountId }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Zernio typing error ${res.status}: ${err}`);
  }

  return res.json();
}

export async function getMetaAdsTree(options = {}) {
  if (!process.env.ZERNIO_API_KEY) {
    throw new Error("ZERNIO_API_KEY is missing. Complete it in your .env file.");
  }

  const accountId = options.accountId || process.env.ZERNIO_META_ADS_ACCOUNT_ID || process.env.ZERNIO_ACCOUNT_ID;
  if (!accountId) {
    throw new Error("ZERNIO_META_ADS_ACCOUNT_ID or ZERNIO_ACCOUNT_ID is missing.");
  }

  const params = new URLSearchParams({ accountId });
  if (options.source) params.set("source", options.source);
  if (options.adAccountId) params.set("adAccountId", options.adAccountId);
  if (options.platform) params.set("platform", options.platform);
  if (options.sort) params.set("sort", options.sort);
  if (options.date) {
    params.set("fromDate", options.date);
    params.set("toDate", options.date);
  }
  if (options.fromDate) params.set("fromDate", options.fromDate);
  if (options.toDate) params.set("toDate", options.toDate);
  if (options.from) params.set("fromDate", options.from);
  if (options.to) params.set("toDate", options.to);

  const res = await zernioFetch(`${BASE_URL}/ads/tree?${params.toString()}`, {
    method: "GET",
    headers: headers(),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Zernio ads tree error ${res.status}: ${err}`);
  }

  return res.json();
}

export async function listZernioAccounts(options = {}) {
  if (!process.env.ZERNIO_API_KEY) {
    throw new Error("ZERNIO_API_KEY is missing. Complete it in your .env file.");
  }

  const params = new URLSearchParams();
  if (options.platform) params.set("platform", options.platform);
  if (options.status) params.set("status", options.status);

  const qs = params.toString();
  const res = await zernioFetch(`${BASE_URL}/accounts${qs ? `?${qs}` : ""}`, {
    method: "GET",
    headers: headers(),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Zernio accounts error ${res.status}: ${err}`);
  }

  return res.json();
}

export async function listMetaAdAccounts(options = {}) {
  if (!process.env.ZERNIO_API_KEY) {
    throw new Error("ZERNIO_API_KEY is missing. Complete it in your .env file.");
  }

  const accountId = options.accountId || process.env.ZERNIO_META_ADS_ACCOUNT_ID || process.env.ZERNIO_ACCOUNT_ID;
  if (!accountId) {
    throw new Error("ZERNIO_META_ADS_ACCOUNT_ID or ZERNIO_ACCOUNT_ID is missing.");
  }

  const params = new URLSearchParams({ accountId });
  if (options.adAccountId) params.set("adAccountId", options.adAccountId);
  if (options.limit) params.set("limit", String(options.limit));

  const res = await zernioFetch(`${BASE_URL}/ads/accounts?${params.toString()}`, {
    method: "GET",
    headers: headers(),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Zernio ad accounts error ${res.status}: ${err}`);
  }

  return res.json();
}

export async function getAdsTimeline(options = {}) {
  if (!process.env.ZERNIO_API_KEY) {
    throw new Error("ZERNIO_API_KEY is missing. Complete it in your .env file.");
  }

  const accountId = options.accountId || process.env.ZERNIO_META_ADS_ACCOUNT_ID || process.env.ZERNIO_ACCOUNT_ID;
  if (!accountId) {
    throw new Error("ZERNIO_META_ADS_ACCOUNT_ID or ZERNIO_ACCOUNT_ID is missing.");
  }

  const params = new URLSearchParams({ accountId });
  if (options.adAccountId) params.set("adAccountId", options.adAccountId);
  if (options.fromDate) params.set("fromDate", options.fromDate);
  if (options.toDate) params.set("toDate", options.toDate);
  if (options.platform) params.set("platform", options.platform);

  const res = await zernioFetch(`${BASE_URL}/ads/timeline?${params.toString()}`, {
    method: "GET",
    headers: headers(),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Zernio ads timeline error ${res.status}: ${err}`);
  }

  return res.json();
}

export async function listInboxConversations(options = {}) {
  if (!process.env.ZERNIO_API_KEY) {
    throw new Error("ZERNIO_API_KEY is missing. Complete it in your .env file.");
  }

  const params = new URLSearchParams();
  if (options.accountId) params.set("accountId", options.accountId);
  if (options.platform) params.set("platform", options.platform);
  if (options.limit) params.set("limit", String(options.limit));
  if (options.cursor) params.set("cursor", options.cursor);

  const qs = params.toString();
  const res = await zernioFetch(`${BASE_URL}/inbox/conversations${qs ? `?${qs}` : ""}`, {
    method: "GET",
    headers: headers(),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Zernio inbox conversations error ${res.status}: ${err}`);
  }

  return res.json();
}

export async function ensureWhatsAppDataset(options = {}) {
  const accountId = options.accountId || process.env.ZERNIO_WHATSAPP_ACCOUNT_ID || process.env.ZERNIO_ACCOUNT_ID;

  if (!process.env.ZERNIO_API_KEY) {
    throw new Error("ZERNIO_API_KEY is missing. Complete it in your .env file.");
  }

  if (!accountId) {
    throw new Error("ZERNIO_WHATSAPP_ACCOUNT_ID or ZERNIO_ACCOUNT_ID is missing.");
  }

  const res = await zernioFetch(`${BASE_URL}/whatsapp/dataset`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ accountId }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Zernio WhatsApp dataset error ${res.status}: ${err}`);
  }

  return res.json();
}

export async function sendWhatsAppConversion(details = {}) {
  const accountId = details.accountId || process.env.ZERNIO_WHATSAPP_ACCOUNT_ID || process.env.ZERNIO_ACCOUNT_ID;

  if (!process.env.ZERNIO_API_KEY) {
    throw new Error("ZERNIO_API_KEY is missing. Complete it in your .env file.");
  }

  if (!accountId) {
    throw new Error("ZERNIO_WHATSAPP_ACCOUNT_ID or ZERNIO_ACCOUNT_ID is missing.");
  }

  const payload = {
    accountId,
    eventName: details.eventName,
    eventId: details.eventId,
    value: details.value,
    currency: details.currency,
  };

  if (details.conversationId) payload.conversationId = details.conversationId;
  if (details.phoneE164) payload.phoneE164 = details.phoneE164;
  if (details.testCode) payload.testCode = details.testCode;

  const res = await zernioFetch(`${BASE_URL}/whatsapp/conversions`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(payload),
  });

  const body = await res.text();
  let parsed;
  try {
    parsed = body ? JSON.parse(body) : {};
  } catch {
    parsed = { raw: body };
  }

  if (!res.ok) {
    const error = new Error(`Zernio WhatsApp conversion error ${res.status}: ${body}`);
    error.response = parsed;
    throw error;
  }

  return parsed;
}

export async function sendAdsConversion(details = {}) {
  const accountId = details.accountId || process.env.ZERNIO_META_ADS_ACCOUNT_ID || process.env.ZERNIO_ACCOUNT_ID;

  if (!process.env.ZERNIO_API_KEY) {
    throw new Error("ZERNIO_API_KEY is missing. Complete it in your .env file.");
  }

  if (!accountId) {
    throw new Error("ZERNIO_META_ADS_ACCOUNT_ID or ZERNIO_ACCOUNT_ID is missing.");
  }

  if (!details.destinationId) {
    throw new Error("Meta Ads destinationId is missing.");
  }

  const event = {
    eventName: details.eventName,
    eventId: details.eventId,
    actionSource: details.actionSource || "chat",
  };

  if (details.eventTime) {
    const ts = new Date(details.eventTime);
    event.eventTime = Math.floor(ts.getTime() / 1000);
  } else {
    event.eventTime = Math.floor(Date.now() / 1000);
  }

  if (details.value != null) event.value = details.value;
  if (details.currency) event.currency = details.currency;

  if (details.userData) {
    event.user = {};
    if (details.userData.externalId) event.user.externalId = details.userData.externalId;
    if (details.userData.phone) event.user.phone = details.userData.phone;
    if (details.userData.email) event.user.email = details.userData.email;
  }

  if (details.customData) event.customData = details.customData;
  if (details.clickId) event.clickId = details.clickId;
  if (details.adId) event.adId = details.adId;
  if (details.conversationId) event.conversationId = details.conversationId;

  const payload = {
    accountId,
    destinationId: details.destinationId,
    events: [event],
  };

  if (details.testCode) payload.testCode = details.testCode;

  const res = await zernioFetch(`${BASE_URL}/ads/conversions`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(payload),
  });

  const body = await res.text();
  let parsed;
  try {
    parsed = body ? JSON.parse(body) : {};
  } catch {
    parsed = { raw: body };
  }

  if (!res.ok) {
    const error = new Error(`Zernio Ads conversion error ${res.status}: ${body}`);
    error.response = parsed;
    throw error;
  }

  return parsed;
}

async function sendConversationMessage(conversationId, payload, options = {}) {
  const accountId = accountIdFrom(options);

  if (!process.env.ZERNIO_API_KEY) {
    throw new Error("ZERNIO_API_KEY is missing. Complete it in your .env file.");
  }

  if (!accountId) {
    throw new Error("ZERNIO_ACCOUNT_ID is missing. Complete it in your .env file.");
  }

  if (!conversationId) {
    throw new Error("conversationId is missing from the Zernio webhook payload.");
  }

  const url = `${BASE_URL}/inbox/conversations/${conversationId}/messages?accountId=${accountId}`;

  const res = await zernioFetch(url, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ ...payload, accountId }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Zernio API error ${res.status}: ${err}`);
  }

  return res.json();
}
