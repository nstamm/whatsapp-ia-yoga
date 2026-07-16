import { config } from "dotenv";
import OpenAI, { toFile } from "openai";
import { getSetting } from "./store.js";

config();
let client;

function getClient() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is missing. Complete it in your .env file.");
  }

  client ??= new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return client;
}

function ensureFirstReplyDetails(text, shouldEnsureDetails) {
  if (!shouldEnsureDetails) return text;

  const missingDetails = [];

  if (!/14[\s.,]?999/.test(text)) {
    missingDetails.push("por hoy: $14999");
  }

  if (!/26[\s.,]?999/.test(text)) {
    missingDetails.push("antes estaba: $26999");
  }

  if (!/kit\.yogapro/i.test(text)) {
    missingDetails.push("alias: kit.yogapro");
  }

  if (missingDetails.length === 0) return text;

  return `${text}\nTe dejo esto a mano: ${missingDetails.join(" · ")}`;
}

function normalizeReplyStyle(text) {
  return String(text ?? "")
    .replaceAll("¿", "")
    .replaceAll("¡", "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function containsPriceOrPaymentDetails(text) {
  return /\$\s?\d|4[\s.,]?999|26[\s.,]?999|14[\s.,]?999|24[\s.,]?999|7[\s.,]?999|kit\.yogapro|ofiprof\.mp|alias|transfer|mercado\s?pago|\bpago\b/i.test(
    text
  );
}

function safeNoPriceProductReply() {
  return (
    "Te cuento: el *Kit Yoga Pro* está pensado para profes de yoga que quieren organizar mejor sus clases y dejar de improvisar.\n" +
    "Incluye plantillas, clases armadas y material de apoyo para preparar encuentros más claros y profesionales. Querés que te pase las opciones disponibles?"
  );
}

function filenameFromAudioUrl(audioUrl, contentType) {
  const pathname = new URL(audioUrl).pathname;
  const filename = pathname.split("/").filter(Boolean).at(-1);

  if (filename?.includes(".")) return filename;
  if (contentType.includes("ogg")) return "whatsapp-audio.ogg";
  if (contentType.includes("mpeg") || contentType.includes("mp3")) return "whatsapp-audio.mp3";
  if (contentType.includes("mp4")) return "whatsapp-audio.mp4";
  if (contentType.includes("wav")) return "whatsapp-audio.wav";

  return "whatsapp-audio.ogg";
}

async function fetchAudio(audioUrl, withAuth = false) {
  const headers = {};

  if (withAuth && process.env.ZERNIO_API_KEY) {
    headers.Authorization = `Bearer ${process.env.ZERNIO_API_KEY}`;
  }

  return fetch(audioUrl, { headers });
}

async function fetchMediaBuffer(mediaUrl, withAuth = false) {
  const headers = {};

  if (withAuth && process.env.ZERNIO_API_KEY) {
    headers.Authorization = `Bearer ${process.env.ZERNIO_API_KEY}`;
  }

  const res = await fetch(mediaUrl, { headers });

  if ((res.status === 401 || res.status === 403) && process.env.ZERNIO_API_KEY && !withAuth) {
    return fetchMediaBuffer(mediaUrl, true);
  }

  if (!res.ok) {
    throw new Error(`Could not download media ${res.status}: ${await res.text()}`);
  }

  return {
    buffer: Buffer.from(await res.arrayBuffer()),
    contentType: res.headers.get("content-type") ?? "image/jpeg",
  };
}

export async function transcribeAudioFromUrl(audioUrl) {
  if (!audioUrl) {
    throw new Error("Audio URL is missing from the webhook payload.");
  }

  let res = await fetchAudio(audioUrl);

  if ((res.status === 401 || res.status === 403) && process.env.ZERNIO_API_KEY) {
    res = await fetchAudio(audioUrl, true);
  }

  if (!res.ok) {
    throw new Error(`Could not download audio ${res.status}: ${await res.text()}`);
  }

  const maxBytes = 25 * 1024 * 1024;
  const contentLength = Number(res.headers.get("content-length") ?? 0);

  if (contentLength > maxBytes) {
    throw new Error("Audio file is larger than OpenAI transcription limit (25MB).");
  }

  const contentType = res.headers.get("content-type") ?? "audio/ogg";
  const audioBuffer = Buffer.from(await res.arrayBuffer());

  if (audioBuffer.byteLength > maxBytes) {
    throw new Error("Audio file is larger than OpenAI transcription limit (25MB).");
  }

  const audioFile = await toFile(audioBuffer, filenameFromAudioUrl(audioUrl, contentType), {
    type: contentType,
  });

  const transcription = await getClient().audio.transcriptions.create({
    file: audioFile,
    model: process.env.OPENAI_TRANSCRIPTION_MODEL ?? "gpt-4o-mini-transcribe",
    language: "es",
  });

  return transcription.text.trim();
}

function isValidExtractedName(value) {
  const name = String(value ?? "").trim().replace(/\s+/g, " ");

  if (name.length < 2 || name.length > 50) return false;
  if (name.split(" ").length > 4) return false;
  if (/https?:|www\.|@|\$|\d{3,}|[¿?¡!]/i.test(name)) return false;
  if (/precio|valor|cuanto|cuánto|producto|kit|yoga|compr|pago|alias|ofiprof|comprobante|transfer|info|pasame|mandame/i.test(name)) {
    return false;
  }

  return /^[a-záéíóúüñ' -]+$/i.test(name);
}

export async function extractNameCaptureWithAI(userMessage) {
  const response = await getClient().chat.completions.create({
    model: getSetting("openai_chat_model", "gpt-4o-mini"),
    max_tokens: 80,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "Extraé el nombre propio de una respuesta a 'Cómo te llamás?'. Devolvé solo JSON con name y remainingText. name debe ser solo el nombre, sin pedidos ni frases extra. remainingText debe ser el resto textual del mensaje, sin inventar. Si no hay nombre claro, name vacío.",
      },
      { role: "user", content: String(userMessage ?? "").slice(0, 500) },
    ],
  });

  try {
    const parsed = JSON.parse(response.choices[0].message.content ?? "{}");
    const name = String(parsed.name ?? "").trim().replace(/\s+/g, " ");
    const remainingText = String(parsed.remainingText ?? "").trim().replace(/\s+/g, " ");

    if (!isValidExtractedName(name)) return { name: "", remainingText: "" };

    return { name, remainingText };
  } catch {
    return { name: "", remainingText: "" };
  }
}

export async function extractPaymentProofDetailsWithAI({ userText = "", imageUrl = "" } = {}) {
  const content = [
    {
      type: "text",
      text:
        "Analizá este posible comprobante de transferencia de Mercado Pago/banco. Devolvé solo JSON con payerName, amount e isPaymentProof. payerName debe ser el nombre de la persona que paga si aparece claro. amount debe ser número entero en pesos si aparece. isPaymentProof true solo si parece comprobante de pago/transferencia.",
    },
    { type: "text", text: `Texto del usuario: ${String(userText ?? "").slice(0, 700)}` },
  ];

  if (imageUrl) {
    const { buffer, contentType } = await fetchMediaBuffer(imageUrl);
    const base64 = buffer.toString("base64");
    content.push({ type: "image_url", image_url: { url: `data:${contentType};base64,${base64}` } });
  }

  const response = await getClient().chat.completions.create({
    model: getSetting("openai_chat_model", "gpt-4o-mini"),
    max_tokens: 120,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "Extraé datos de comprobantes de pago. Devolvé JSON estricto: payerName string, amount number o 0, isPaymentProof boolean. No inventes nombres ni montos.",
      },
      { role: "user", content },
    ],
  });

  try {
    const parsed = JSON.parse(response.choices[0].message.content ?? "{}");
    const payerName = String(parsed.payerName ?? "").trim().replace(/\s+/g, " ");
    const amount = Number.parseInt(String(parsed.amount ?? "0").replace(/[^0-9]/g, ""), 10) || 0;

    return {
      payerName: isValidExtractedName(payerName) ? payerName : "",
      amount,
      isPaymentProof: Boolean(parsed.isPaymentProof),
    };
  } catch {
    return { payerName: "", amount: 0, isPaymentProof: false };
  }
}

export async function getAIResponse(phoneNumber, userMessage, history, options = {}) {
  const isFirstReply = history.length === 0;
  const isPaidContact = Boolean(options.isPaidContact);
  const isPriceInquiry = Boolean(options.isPriceInquiry);
  const firstReplyPrompt = isPriceInquiry
    ? getSetting("first_reply_prompt")
    : "Primer mensaje util: 1 o 2 lineas, tono humano de chat. Si vienen de un anuncio o preguntan por el Kit Yoga Pro, contá natural que está pensado para profes de yoga que quieren organizar clases, usar plantillas listas y dejar de improvisar. No menciones precios ni alias de pago. No uses signos de apertura. Cerrá con una pregunta corta solo si ayuda.";
  const salesBoundary = isPaidContact
    ? ""
    : isPriceInquiry
      ? "La persona pregunto por precio, valor, pago o compra. Si mencionas precio, siempre deci que por hoy esta $14999 y antes estaba $26999. No escribas alias ni nombre de cuenta; el sistema los manda separados despues del video para que sean faciles de copiar."
      : "No menciones precios, alias de pago ni instrucciones de compra salvo que la persona pregunte explicitamente por precio, valor, pago o como comprar. Si viene de un anuncio o pregunta por el producto, explicá que ayuda a profes de yoga a organizar clases, usar plantillas listas y dejar de improvisar. No lo vendas como práctica personal salvo que lo pidan.";
  const messages = [
    { role: "system", content: getSetting("master_prompt") },
    {
      role: "system",
      content: isPaidContact
        ? getSetting("paid_reply_prompt")
        : isFirstReply
          ? firstReplyPrompt
          : getSetting("next_reply_prompt"),
    },
    ...(salesBoundary ? [{ role: "system", content: salesBoundary }] : []),
    ...history,
    { role: "user", content: userMessage },
  ];

  const response = await getClient().chat.completions.create({
    model: getSetting("openai_chat_model", "gpt-4o-mini"),
    max_tokens: Number(getSetting("openai_max_tokens", "180")),
    temperature: Number(getSetting("openai_temperature", "0.9")),
    presence_penalty: 0.25,
    frequency_penalty: 0.25,
    messages,
  });

  const text = response.choices[0].message.content;

  if (!isPaidContact && !isPriceInquiry && containsPriceOrPaymentDetails(text)) {
    return normalizeReplyStyle(safeNoPriceProductReply());
  }

  return normalizeReplyStyle(ensureFirstReplyDetails(text, isFirstReply && !isPaidContact && isPriceInquiry));
}
