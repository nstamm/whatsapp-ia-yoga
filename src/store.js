import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { DatabaseSync } from "node:sqlite";
import { businessDateRange, isBusinessDateKey } from "./businessDate.js";
import { measureSync } from "./performanceMetrics.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = process.env.CRM_DATA_DIR
  ? path.resolve(process.env.CRM_DATA_DIR)
  : path.resolve(__dirname, "..", "data");
const DB_PATH = path.join(DATA_DIR, "ofiprof-crm.sqlite");

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
db.exec("PRAGMA busy_timeout = 5000");

function measuredAll(name, statement, params = []) {
  return measureSync(name, () => statement.all(...params));
}

function measuredGet(name, statement, params = []) {
  return measureSync(name, () => statement.get(...params));
}

const LEGACY_MASTER_PROMPT = `Sos una persona del equipo comercial de Ofiprof respondiendo por WhatsApp a leads que llegan desde anuncios de Meta.

Producto principal: Kit Yoga Pro.
- Infoproducto para aprender yoga desde nivel inicial hasta experto.
- Incluye 6 modulos progresivos.
- Formato: videos + audios para practicar y repasar.
- Solo por hoy: $4999.
- Antes estaba: $26999.
- Version completa incluye 3 bonus de productividad.
- Alias de pago: kit.yogapro

Objetivo comercial:
- Llevar la conversacion hacia la compra sin sonar insistente.
- En el primer mensaje util al lead, presentar el producto en version corta, mostrar ambos precios y pasar el alias kit.yogapro.
- Recomendar la version completa cuando tenga sentido, porque suma los 3 bonus.
- Si la persona duda, resolver objeciones de forma simple: nivel inicial, tiempo, acceso a videos/audios, diferencia de precios, bonus, forma de pago.
- Si la persona pide pagar, repetir alias y pedir que envie comprobante por este chat.
- Si la persona dice que ya pago o envio comprobante, no sigas vendiendo: agradece y deci que una persona del equipo lo revisa.
- No inventes otros descuentos ni precios: solo por hoy $4999, antes $26999.

Estilo de respuesta:
- Español rioplatense natural, con voseo.
- Sona humano, cercano y tranquilo. No digas que sos IA, bot, automatizacion ni asistente virtual.
- Varia saludos, estructura y palabras en cada respuesta. Evita repetir plantillas exactas.
- Usa 1 o 2 emojis como maximo cuando sumen calidez.
- WhatsApp: mensajes breves, con saltos de linea, bullets simples y negritas con *texto*.
- Respuestas cortas: 2 a 4 lineas como maximo.
- Evita bloques largos y evita separar cada idea con una linea vacia.
- Una sola pregunta al final, solo si ayuda a avanzar.
- No repitas toda la oferta si ya la explicaste.
- No prometas acceso instantaneo ni links si el usuario no los dio.
- No inventes descuentos, garantias, cuotas, stock, fechas, plataformas ni medios de pago extra.

Datos que siempre deben ser consistentes:
- Marca: Ofiprof.
- Producto: Kit Yoga Pro.
- Precio por hoy: $4999.
- Precio anterior: $26999.
- Alias: kit.yogapro`;

const LEGACY_FIRST_REPLY_PROMPT =
  "Primer mensaje util: maximo 4 lineas. Si preguntan por el Kit Yoga Pro, contá de forma natural que incluye modulos con videos/audios para practicar y ordenar la rutina. No menciones precios ni alias salvo que pregunten precio o como comprar. Una pregunta corta al final.";

const LEGACY_NEXT_REPLY_PROMPT =
  "Ya hay conversacion previa. Responde en 1 a 3 lineas, segun contexto, y no repitas toda la presentacion salvo que la persona la pida. No menciones precios ni alias salvo que pregunten precio o como comprar.";

const LEGACY_ASK_NAME_TEXT = "¿Cómo te llamás?";

const LEGACY_HUMANIZED_MASTER_PROMPT = `Sos una persona del equipo comercial de Ofiprof respondiendo por WhatsApp a leads que llegan desde anuncios de Meta.
Producto principal: Kit Yoga Pro. Es un infoproducto para aprender yoga desde nivel inicial hasta experto. Incluye 6 modulos progresivos en formato videos + audios para practicar y repasar. Solo por hoy esta $4999. Antes estaba $26999. Alias de pago: kit.yogapro. A nombre de Nicolas Stamm.
Objetivo comercial: acompañar la conversacion hacia la compra sin sonar insistente. Priorizá mensajes cortos y naturales. Si el sistema ya mandó audio o imagen, apoyate en eso y no repitas toda la explicación. Mencioná precios y alias solo si la persona pregunta por precio, pago o compra.
Estilo: español rioplatense con voseo. Soná como una persona real, cercana y tranquila. No digas que sos IA, bot, automatizacion ni asistente virtual. No uses signos de apertura como ¿ o ¡. Usá pocos saltos de linea: preferí 1 parrafo corto o 2 lineas como maximo. Evitá bloques largos, listas largas y tono de folleto. Una sola pregunta al final cuando ayude a avanzar.
No inventes descuentos, garantias, cuotas, stock, fechas, plataformas ni medios de pago extra. Si mencionas precio, siempre deci que por hoy esta $4999 y antes estaba $26999.`;

const LEGACY_HUMANIZED_FIRST_REPLY_PROMPT =
  "Primer mensaje util: 1 o 2 lineas, tono humano de WhatsApp. Si preguntan por el Kit Yoga Pro, contá natural que incluye videos y audios para practicar y ordenar la rutina. No uses signos de apertura. No menciones precios ni alias salvo que pregunten precio o como comprar. Cerrá con una pregunta corta solo si ayuda.";

const LEGACY_HUMANIZED_NEXT_REPLY_PROMPT =
  "Ya hay conversacion previa. Responde como persona real en 1 o 2 lineas, con pocos saltos de linea. No repitas toda la presentacion salvo que la persona la pida. No uses signos de apertura. No menciones precios ni alias salvo que pregunten precio o como comprar.";

const DEFAULT_MASTER_PROMPT = `Sos una persona del equipo comercial de Ofiprof respondiendo por chat a leads que llegan desde anuncios de Meta, WhatsApp o Instagram.

Producto principal: Kit Yoga Pro. Es un recurso para profesores, profesoras e instructores de yoga que quieren organizar mejor sus clases, dejar de improvisar y tener plantillas listas para usar. Incluye clases armadas, secuencias, videos y audios de apoyo para preparar encuentros más claros, ordenados y profesionales.

Oferta vigente:
- Antes ~$26.999~.
- Solo por hoy $14.999.
- El alias de pago lo manda el sistema en un mensaje separado despues de enviar el video del material.

Flujo comercial:
- Si la persona pide información, respondé breve y natural, enfocando en organización de clases, plantillas listas, ahorro de tiempo y seguridad para enseñar.
- No inventes precios, descuentos, cuotas, garantías, fechas, stock, plataformas ni medios de pago.
- Si mencionás precio, siempre usá $14.999 y precio anterior $26.999.
- No escribas el alias kit.yogapro ni el nombre Nicolás Stamm en respuestas de IA; eso lo envia el sistema despues del video para que quede facil de copiar.
- Si la persona pregunta cómo pagar antes del video, respondé natural que primero le compartís una vista del material y después le dejás el alias.
- Si la persona dice que pagó o manda comprobante, no sigas vendiendo.
- No vendas el kit como curso de práctica personal salvo que la persona lo pregunte específicamente.

Estilo:
- Español rioplatense con voseo.
- Soná como una persona real, cercana y tranquila.
- No digas que sos IA, bot, automatización ni asistente virtual.
- No uses signos de apertura como ¿ o ¡.
- Respuestas cortas: 1 a 3 líneas.
- Evitá bloques largos, listas largas y tono de folleto.
- Una sola pregunta al final solo cuando ayude a avanzar.`;

const DEFAULT_FIRST_REPLY_PROMPT =
  "Primer mensaje util: 1 o 2 lineas, tono humano de chat. Si preguntan por el Kit Yoga Pro, contá natural que está pensado para profes de yoga que quieren organizar clases, usar plantillas listas y dejar de improvisar. No uses signos de apertura. No menciones alias. Cerrá con una pregunta corta solo si ayuda.";

const DEFAULT_NEXT_REPLY_PROMPT =
  "Ya hay conversacion previa. Respondé como persona real en 1 o 2 lineas, con foco en organizacion de clases, plantillas listas, ahorro de tiempo y seguridad para enseñar. No repitas toda la presentacion salvo que la persona lo pida. No uses signos de apertura. Si mencionás precio, siempre decí $14.999 y antes $26.999. No escribas el alias ni el nombre de la cuenta; el sistema lo manda separado despues del video.";

const DEFAULT_FOLLOWUP_TEXT =
  `te libero el acceso ahora para que puedas verlo tranquilo.

Si te sirve y lo vas a usar, después nos transferís los $14.999 al alias:

kit.yogapro
A nombre de Nicolás Stamm

Acá tenés el material:
{{product_access_url}}`;

const DEFAULT_FOLLOWUP_REMINDER_TEXT = `holaa, pudiste ver el material? sigue activa la oferta de $14.999 por hoy 🪴

cualquier cosa estoy por acá`;

const DEFAULT_REMINDER_DETAIL_TEXT = "holaa, te mando por acá el detalle porque antes te mandé solo el video 🪴";

const DEFAULT_REMINDER_PRODUCT_DESCRIPTION = `Te cuento bien qué incluye la oferta:

El Kit Profe de Yoga-Pro es un sistema completo para que puedas planificar tus clases, organizar a tus alumnos y trabajar con más seguridad, sin perder horas buscando ideas o improvisando.

Incluye:

✅ 6 tomos en PDF
✅ 36 módulos, desde nivel básico hasta avanzado
✅ Más de 250 páginas
✅ Secuencias, posturas, alineación y planificación de clases
✅ Yoga terapéutico y adaptativo
✅ Pranayama, meditación y filosofía
✅ 6 videos explicativos
✅ 6 cuestionarios para fijar los contenidos

Además, te llevás los 3 Bonos de Productividad:

📁 Carpeta del Profesor: fichas médicas, asistencia, pagos, recibos y planificación anual.

📣 De Profe a Centro de Yoga: flyers, guiones de WhatsApp, clases abiertas y sistema de referidos para conseguir alumnos.

🧘‍♀️ Creación de Talleres Especiales: 8 talleres listos para ofrecer, con cronograma, precios orientativos y guiones de venta.

También incluyen sus versiones en audio para que puedas escucharlos cuando quieras.

En total recibís:

9 PDFs + 6 videos + 6 cuestionarios + 3 audios

El acceso es inmediato, el material es descargable y podés usarlo desde el celular, tablet o computadora.

El valor habitual del paquete completo es de $49.999, pero hoy podés llevarte el Kit completo más los 3 bonos por un único pago de $14.999.

Tenés además 7 días de garantía.

La idea es que tengas todo tu año de yoga resuelto: menos tiempo planificando y más energía para tus clases 🪴`;

const DEFAULT_REMINDER2_OFFER_TEXT = `¡Hola! Queremos que el dinero no sea un obstáculo y que este material llegue a todas las personas que lo necesiten.

Por eso, podés llevarte el Kit completo + los 3 bonos por solo $6.999.

Cualquier cosa, acá estamos 🌿`;

const DEFAULT_PAID_REPLY_PROMPT =
  "Esta persona ya compro el Kit Yoga Pro. Responde como soporte post-compra en 1 o 2 lineas, tono humano y sin signos de apertura. Ayuda con acceso, uso del material o dudas simples. No vendas, no ofrezcas descuentos y no repitas precios.";

const DEFAULT_PRODUCT_ACCESS_URL =
  "https://drive.google.com/drive/folders/1sbAMMzvpmxZTXlK8psdeoZazBMzf4d6h";

const DEFAULT_PRODUCT_DELIVERY_TEXT = `Pago confirmado ✅
Te dejo el acceso al material del *Kit Yoga Pro*:
{{product_access_url}}
Cualquier cosa, escribime por acá.`;

export const DEFAULT_INFO_PAYMENT_TEXT = `si me das el ok, te comparto una vista del material para que no compres a ciegas y puedas ver la calidad 🪴

antes ~$26.999~. solo por hoy $14.999✨`;

const DEFAULT_ASK_NAME_TEXT = "Cómo te llamás?";

const DEFAULT_FLASH_OFFER_TEXT = `el dinero no tiene que ser un obstáculo para empezar 🌱

Te ofrezco una *oferta relámpago*: el *Kit Yoga Pro* completo por solo *$6.999* (antes *$26.999*).

Si te interesa, depositás al alias:

kit.yogapro
A nombre de Nicolás Stamm

y me mandás el comprobante por acá ✨`;

const DEFAULT_SETTINGS = {
  master_prompt: DEFAULT_MASTER_PROMPT,
  first_reply_prompt: DEFAULT_FIRST_REPLY_PROMPT,
  next_reply_prompt: DEFAULT_NEXT_REPLY_PROMPT,
  followup_text: DEFAULT_FOLLOWUP_TEXT,
  followup_reminder_text: DEFAULT_FOLLOWUP_REMINDER_TEXT,
  reminder_detail_text: DEFAULT_REMINDER_DETAIL_TEXT,
  reminder_product_description: DEFAULT_REMINDER_PRODUCT_DESCRIPTION,
  reminder2_offer_text: DEFAULT_REMINDER2_OFFER_TEXT,
  paid_reply_prompt: DEFAULT_PAID_REPLY_PROMPT,
  flash_offer_text: DEFAULT_FLASH_OFFER_TEXT,
  ask_name_text: DEFAULT_ASK_NAME_TEXT,
  openai_chat_model: "gpt-4o-mini",
  openai_max_tokens: "180",
  openai_temperature: "0.9",
  product_access_url: DEFAULT_PRODUCT_ACCESS_URL,
  product_delivery_text: DEFAULT_PRODUCT_DELIVERY_TEXT,
  meta_ads_destination_id: "",
};

db.exec(`
  CREATE TABLE IF NOT EXISTS contacts (
    phone_number TEXT PRIMARY KEY,
    contact_key TEXT NOT NULL DEFAULT '',
    conversation_id TEXT DEFAULT '',
    channel TEXT NOT NULL DEFAULT 'whatsapp',
    account_id TEXT DEFAULT '',
    external_id TEXT DEFAULT '',
    display_handle TEXT DEFAULT '',
    conversation_url TEXT DEFAULT '',
    ctwa_clid TEXT DEFAULT '',
    ctwa_source_id TEXT DEFAULT '',
    ctwa_source_url TEXT DEFAULT '',
    ctwa_headline TEXT DEFAULT '',
    ctwa_source_type TEXT DEFAULT '',
    ctwa_captured_at TEXT,
    attribution_at TEXT,
    ctwa_raw_json TEXT NOT NULL DEFAULT '',
    paid INTEGER NOT NULL DEFAULT 0,
    paid_at TEXT,
    product_link_sent INTEGER NOT NULL DEFAULT 0,
    product_link_sent_at TEXT,
    handoff INTEGER NOT NULL DEFAULT 0,
    handoff_reason TEXT DEFAULT '',
    handoff_last_message TEXT DEFAULT '',
    greeting_sent INTEGER NOT NULL DEFAULT 0,
    greeting_audio_sent INTEGER NOT NULL DEFAULT 0,
    promo_scheduled_at TEXT,
    promo_sent INTEGER NOT NULL DEFAULT 0,
    promo_sent_at TEXT,
    reminder_scheduled_at TEXT,
    reminder_attempted_at TEXT,
    reminder_sent_at TEXT,
    reminder2_scheduled_at TEXT,
    reminder2_attempted_at TEXT,
    reminder2_sent_at TEXT,
    material_preview_offered INTEGER NOT NULL DEFAULT 0,
    material_video_sent INTEGER NOT NULL DEFAULT 0,
    last_incoming_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone_number TEXT NOT NULL,
    contact_key TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    at TEXT NOT NULL,
    FOREIGN KEY (phone_number) REFERENCES contacts(phone_number) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone_number TEXT NOT NULL,
    contact_key TEXT NOT NULL DEFAULT '',
    product_code TEXT NOT NULL,
    product_name TEXT NOT NULL,
    amount INTEGER NOT NULL,
    discount INTEGER NOT NULL DEFAULT 0,
    note TEXT NOT NULL DEFAULT '',
    paid_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (phone_number) REFERENCES contacts(phone_number) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS ad_spend (
    date TEXT PRIMARY KEY,
    amount INTEGER NOT NULL DEFAULT 0,
    note TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS meta_ads_daily_metrics (
    date TEXT NOT NULL,
    ad_account_id TEXT NOT NULL,
    ad_account_name TEXT NOT NULL DEFAULT '',
    account_id TEXT NOT NULL DEFAULT '',
    spend REAL NOT NULL DEFAULT 0,
    impressions INTEGER NOT NULL DEFAULT 0,
    clicks INTEGER NOT NULL DEFAULT 0,
    cpc REAL NOT NULL DEFAULT 0,
    cpm REAL NOT NULL DEFAULT 0,
    conversions INTEGER NOT NULL DEFAULT 0,
    purchase_value REAL NOT NULL DEFAULT 0,
    roas REAL NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT '',
    usd_ars_rate REAL NOT NULL DEFAULT 0,
    source TEXT NOT NULL DEFAULT 'zernio',
    raw_json TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    PRIMARY KEY (date, ad_account_id)
  );

  CREATE TABLE IF NOT EXISTS meta_conversion_events (
    event_id TEXT PRIMARY KEY,
    payment_id INTEGER,
    phone_number TEXT NOT NULL DEFAULT '',
    account_id TEXT NOT NULL DEFAULT '',
    conversation_id TEXT NOT NULL DEFAULT '',
    event_name TEXT NOT NULL DEFAULT '',
    value REAL NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    response_json TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '',
    sent_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS revenue_adjustments (
    date TEXT PRIMARY KEY,
    amount INTEGER NOT NULL DEFAULT 0,
    note TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  );
`);

function normalizeContactKey(value, accountId = "") {
  const identity = String(value ?? "").trim().toLowerCase();
  if (!identity) return identity;
  if (/^(ig|fb):/.test(identity) && accountId && identity.split(":").length === 2) {
    const [prefix, externalId] = identity.split(":");
    return `${prefix}:${String(accountId).trim().toLowerCase()}:${externalId}`;
  }
  if (identity.includes(":")) return identity;
  return identity.replace(/\D/g, "") || identity;
}

db.exec("BEGIN IMMEDIATE");
try {
const contactColumns = db.prepare("PRAGMA table_info(contacts)").all().map((column) => column.name);

const contactMigrations = [
  ["contact_key", "ALTER TABLE contacts ADD COLUMN contact_key TEXT NOT NULL DEFAULT ''"],
  ["channel", "ALTER TABLE contacts ADD COLUMN channel TEXT NOT NULL DEFAULT 'whatsapp'"],
  ["account_id", "ALTER TABLE contacts ADD COLUMN account_id TEXT DEFAULT ''"],
  ["external_id", "ALTER TABLE contacts ADD COLUMN external_id TEXT DEFAULT ''"],
  ["display_handle", "ALTER TABLE contacts ADD COLUMN display_handle TEXT DEFAULT ''"],
  ["conversation_url", "ALTER TABLE contacts ADD COLUMN conversation_url TEXT DEFAULT ''"],
  ["ctwa_clid", "ALTER TABLE contacts ADD COLUMN ctwa_clid TEXT DEFAULT ''"],
  ["ctwa_source_id", "ALTER TABLE contacts ADD COLUMN ctwa_source_id TEXT DEFAULT ''"],
  ["ctwa_source_url", "ALTER TABLE contacts ADD COLUMN ctwa_source_url TEXT DEFAULT ''"],
  ["ctwa_headline", "ALTER TABLE contacts ADD COLUMN ctwa_headline TEXT DEFAULT ''"],
  ["ctwa_source_type", "ALTER TABLE contacts ADD COLUMN ctwa_source_type TEXT DEFAULT ''"],
  ["ctwa_captured_at", "ALTER TABLE contacts ADD COLUMN ctwa_captured_at TEXT"],
  ["attribution_at", "ALTER TABLE contacts ADD COLUMN attribution_at TEXT"],
  ["ctwa_raw_json", "ALTER TABLE contacts ADD COLUMN ctwa_raw_json TEXT NOT NULL DEFAULT ''"],
  ["product_link_sent", "ALTER TABLE contacts ADD COLUMN product_link_sent INTEGER NOT NULL DEFAULT 0"],
  ["product_link_sent_at", "ALTER TABLE contacts ADD COLUMN product_link_sent_at TEXT"],
  ["handoff", "ALTER TABLE contacts ADD COLUMN handoff INTEGER NOT NULL DEFAULT 0"],
  ["handoff_reason", "ALTER TABLE contacts ADD COLUMN handoff_reason TEXT DEFAULT ''"],
  ["handoff_last_message", "ALTER TABLE contacts ADD COLUMN handoff_last_message TEXT DEFAULT ''"],
  ["greeting_sent", "ALTER TABLE contacts ADD COLUMN greeting_sent INTEGER NOT NULL DEFAULT 0"],
  ["greeting_audio_sent", "ALTER TABLE contacts ADD COLUMN greeting_audio_sent INTEGER NOT NULL DEFAULT 0"],
  ["promo_scheduled_at", "ALTER TABLE contacts ADD COLUMN promo_scheduled_at TEXT"],
  ["promo_sent", "ALTER TABLE contacts ADD COLUMN promo_sent INTEGER NOT NULL DEFAULT 0"],
  ["promo_sent_at", "ALTER TABLE contacts ADD COLUMN promo_sent_at TEXT"],
  ["reminder_scheduled_at", "ALTER TABLE contacts ADD COLUMN reminder_scheduled_at TEXT"],
  ["reminder_attempted_at", "ALTER TABLE contacts ADD COLUMN reminder_attempted_at TEXT"],
  ["reminder_sent_at", "ALTER TABLE contacts ADD COLUMN reminder_sent_at TEXT"],
  ["reminder2_scheduled_at", "ALTER TABLE contacts ADD COLUMN reminder2_scheduled_at TEXT"],
  ["reminder2_attempted_at", "ALTER TABLE contacts ADD COLUMN reminder2_attempted_at TEXT"],
  ["reminder2_sent_at", "ALTER TABLE contacts ADD COLUMN reminder2_sent_at TEXT"],
  ["material_preview_offered", "ALTER TABLE contacts ADD COLUMN material_preview_offered INTEGER NOT NULL DEFAULT 0"],
  ["material_video_sent", "ALTER TABLE contacts ADD COLUMN material_video_sent INTEGER NOT NULL DEFAULT 0"],
  ["material_video_sent_at", "ALTER TABLE contacts ADD COLUMN material_video_sent_at TEXT"],
  ["last_incoming_at", "ALTER TABLE contacts ADD COLUMN last_incoming_at TEXT"],
  ["name", "ALTER TABLE contacts ADD COLUMN name TEXT DEFAULT ''"],
  ["name_asked", "ALTER TABLE contacts ADD COLUMN name_asked INTEGER NOT NULL DEFAULT 0"],
];

for (const [column, sql] of contactMigrations) {
  if (!contactColumns.includes(column)) {
    db.exec(sql);
  }
}

const messageColumns = db.prepare("PRAGMA table_info(messages)").all().map((column) => column.name);
if (!messageColumns.includes("contact_key")) db.exec("ALTER TABLE messages ADD COLUMN contact_key TEXT NOT NULL DEFAULT ''");
const paymentColumns = db.prepare("PRAGMA table_info(payments)").all().map((column) => column.name);
if (!paymentColumns.includes("contact_key")) db.exec("ALTER TABLE payments ADD COLUMN contact_key TEXT NOT NULL DEFAULT ''");

const metaAdsColumns = db.prepare("PRAGMA table_info(meta_ads_daily_metrics)").all().map((column) => column.name);
if (!metaAdsColumns.includes("ad_account_id")) {
  db.exec(`
    CREATE TABLE meta_ads_daily_metrics_v2 (
      date TEXT NOT NULL,
      ad_account_id TEXT NOT NULL,
      ad_account_name TEXT NOT NULL DEFAULT '',
      account_id TEXT NOT NULL DEFAULT '',
      spend REAL NOT NULL DEFAULT 0,
      impressions INTEGER NOT NULL DEFAULT 0,
      clicks INTEGER NOT NULL DEFAULT 0,
      cpc REAL NOT NULL DEFAULT 0,
      cpm REAL NOT NULL DEFAULT 0,
      conversions INTEGER NOT NULL DEFAULT 0,
      purchase_value REAL NOT NULL DEFAULT 0,
      roas REAL NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT '',
      usd_ars_rate REAL NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'zernio',
      raw_json TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL,
      PRIMARY KEY (date, ad_account_id)
    );
    INSERT INTO meta_ads_daily_metrics_v2 (
      date, ad_account_id, account_id, spend, impressions, clicks, cpc, cpm,
      conversions, purchase_value, roas, currency, source, raw_json, updated_at
    )
    SELECT date, '', account_id, spend, impressions, clicks, cpc, cpm,
           conversions, purchase_value, roas, currency, source, raw_json, updated_at
    FROM meta_ads_daily_metrics;
    DROP TABLE meta_ads_daily_metrics;
    ALTER TABLE meta_ads_daily_metrics_v2 RENAME TO meta_ads_daily_metrics;
  `);
}

const backfillContactKey = db.prepare("UPDATE contacts SET contact_key = ?, attribution_at = CASE WHEN attribution_at IS NULL AND ctwa_source_id != '' THEN COALESCE(ctwa_captured_at, created_at) ELSE attribution_at END WHERE phone_number = ?");
for (const row of db.prepare("SELECT phone_number, account_id FROM contacts WHERE contact_key = '' OR (attribution_at IS NULL AND ctwa_source_id != '')").all()) {
  backfillContactKey.run(normalizeContactKey(row.phone_number, row.account_id), row.phone_number);
}
const contactKeysByPhone = new Map(db.prepare("SELECT phone_number, contact_key FROM contacts").all().map((row) => [row.phone_number, row.contact_key]));
const backfillMessageKey = db.prepare("UPDATE messages SET contact_key = ? WHERE phone_number = ? AND contact_key = ''");
for (const row of db.prepare("SELECT DISTINCT phone_number FROM messages WHERE contact_key = ''").all()) {
  backfillMessageKey.run(contactKeysByPhone.get(row.phone_number) ?? normalizeContactKey(row.phone_number), row.phone_number);
}
const backfillPaymentKey = db.prepare("UPDATE payments SET contact_key = ? WHERE phone_number = ? AND contact_key = ''");
for (const row of db.prepare("SELECT DISTINCT phone_number FROM payments WHERE contact_key = ''").all()) {
  backfillPaymentKey.run(contactKeysByPhone.get(row.phone_number) ?? normalizeContactKey(row.phone_number), row.phone_number);
}

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_contacts_updated_at ON contacts(updated_at);
  CREATE INDEX IF NOT EXISTS idx_contacts_handoff_updated_at ON contacts(handoff, updated_at);
  CREATE INDEX IF NOT EXISTS idx_contacts_last_incoming_at ON contacts(last_incoming_at);
  CREATE INDEX IF NOT EXISTS idx_contacts_contact_key ON contacts(contact_key);
  CREATE INDEX IF NOT EXISTS idx_contacts_ctwa_attribution ON contacts(ctwa_source_id, attribution_at, contact_key);
  CREATE INDEX IF NOT EXISTS idx_contacts_attribution_date ON contacts(attribution_at, contact_key) WHERE ctwa_source_id != '';
  CREATE INDEX IF NOT EXISTS idx_contacts_reminder_due ON contacts(reminder_scheduled_at) WHERE reminder_sent_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_contacts_reminder2_due ON contacts(reminder2_scheduled_at) WHERE reminder2_sent_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_contacts_reminder_claimable ON contacts(reminder_scheduled_at) WHERE reminder_sent_at IS NULL AND reminder_attempted_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_contacts_reminder2_claimable ON contacts(reminder2_scheduled_at) WHERE reminder2_sent_at IS NULL AND reminder2_attempted_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_messages_phone_id ON messages(phone_number, id);
  CREATE INDEX IF NOT EXISTS idx_messages_phone_role ON messages(phone_number, role);
  CREATE INDEX IF NOT EXISTS idx_messages_at ON messages(at);
  CREATE INDEX IF NOT EXISTS idx_messages_contact_role_at ON messages(contact_key, role, at);
  CREATE INDEX IF NOT EXISTS idx_payments_phone_paid_at ON payments(phone_number, paid_at);
  CREATE INDEX IF NOT EXISTS idx_payments_paid_at ON payments(paid_at);
  CREATE INDEX IF NOT EXISTS idx_payments_contact_paid_at ON payments(contact_key, paid_at);
  CREATE INDEX IF NOT EXISTS idx_meta_ads_account_date ON meta_ads_daily_metrics(ad_account_id, date);
`);
db.exec("COMMIT");
} catch (error) {
  db.exec("ROLLBACK");
  throw error;
}

for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)").run(key, value);
}

function migrateDefaultSetting(key, nextValue, legacyValues) {
  const update = db.prepare("UPDATE settings SET value = ? WHERE key = ? AND value = ?");

  for (const legacyValue of legacyValues) {
    update.run(nextValue, key, legacyValue);
  }
}

function replaceSettingText(key, fromText, toText) {
  db.prepare("UPDATE settings SET value = replace(value, ?, ?) WHERE key = ?").run(fromText, toText, key);
}

migrateDefaultSetting("master_prompt", DEFAULT_MASTER_PROMPT, [LEGACY_MASTER_PROMPT, LEGACY_HUMANIZED_MASTER_PROMPT]);
migrateDefaultSetting("master_prompt", DEFAULT_MASTER_PROMPT, [
  `Sos una persona del equipo comercial de Ofiprof respondiendo por WhatsApp a leads que llegan desde anuncios de Meta.

Producto principal: Kit Yoga Pro. Es un recurso para profesores, profesoras e instructores de yoga que quieren organizar mejor sus clases, dejar de improvisar y tener plantillas listas para usar. Incluye clases armadas, secuencias, videos y audios de apoyo para preparar encuentros más claros, ordenados y profesionales.

Oferta vigente:
- Antes ~$26.999~.
- Solo por hoy $4.999.
- Alias de pago: kit.yogapro.
- A nombre de Nicolás Stamm.

Flujo comercial:
- Si la persona pide información, respondé breve y natural, enfocando en organización de clases, plantillas listas, ahorro de tiempo y seguridad para enseñar.
- No inventes precios, descuentos, cuotas, garantías, fechas, stock, plataformas ni medios de pago.
- Si mencionás precio, siempre usá $4.999 y precio anterior $26.999.
- Si la persona pregunta cómo pagar, indicá alias kit.yogapro a nombre de Nicolás Stamm y pedí que envíe el comprobante por este chat.
- Si la persona dice que pagó o manda comprobante, no sigas vendiendo.
- No vendas el kit como curso de práctica personal salvo que la persona lo pregunte específicamente.

Estilo:
- Español rioplatense con voseo.
- Soná como una persona real, cercana y tranquila.
- No digas que sos IA, bot, automatización ni asistente virtual.
- No uses signos de apertura como ¿ o ¡.
- Respuestas cortas: 1 a 3 líneas.
- Evitá bloques largos, listas largas y tono de folleto.
- Una sola pregunta al final solo cuando ayude a avanzar.`,
  `Sos una persona del equipo comercial de Ofiprof respondiendo por WhatsApp a leads que llegan desde anuncios de Meta.
Producto principal: Kit Yoga Pro. Es un recurso para profesores, profesoras e instructores de yoga que quieren organizar mejor sus clases, dejar de improvisar y tener plantillas listas para usar. Incluye clases armadas, secuencias, videos y audios de apoyo para preparar encuentros más claros, ordenados y profesionales. Version base sin bonus: $14999. Version completa con 3 bonus de productividad: $24999. Alias de pago: kit.yogapro
Dolor principal: muchos profes saben enseñar, pero pierden tiempo pensando qué clase dar, cómo estructurarla o cómo variar sus propuestas. El kit ayuda a tener una base organizada para planificar más rápido, dar clases con más seguridad y acompañar mejor a sus alumnos.
Objetivo comercial: acompañar la conversacion hacia la compra sin sonar insistente. Enfocá la venta en organizacion, claridad, ahorro de tiempo, clases listas y crecimiento profesional como profe. Si el sistema ya mandó audio o imagen, apoyate en eso y no repitas toda la explicación. No lo vendas como un curso para profundizar la práctica personal salvo que la persona lo pregunte específicamente. Mencioná precios y alias solo si la persona pregunta por precio, pago o compra.
Estilo: español rioplatense con voseo. Soná como una persona real, cercana y tranquila. No digas que sos IA, bot, automatizacion ni asistente virtual. No uses signos de apertura como ¿ o ¡. Usá pocos saltos de linea: preferí 1 parrafo corto o 2 lineas como maximo. Evitá bloques largos, listas largas y tono de folleto. Una sola pregunta al final cuando ayude a avanzar.
No inventes descuentos, garantias, cuotas, stock, fechas, plataformas ni medios de pago extra. No ofrezcas el descuento de $7999 salvo que el sistema lo envie como recuperacion.`,
]);
migrateDefaultSetting("first_reply_prompt", DEFAULT_FIRST_REPLY_PROMPT, [
  LEGACY_FIRST_REPLY_PROMPT,
  LEGACY_HUMANIZED_FIRST_REPLY_PROMPT,
  "Primer mensaje util: 1 o 2 lineas, tono humano de WhatsApp. Si preguntan por el Kit Yoga Pro, contá natural que está pensado para profes de yoga que quieren organizar clases, usar plantillas listas y dejar de improvisar. No uses signos de apertura. No menciones precios ni alias salvo que pregunten precio o como comprar. Cerrá con una pregunta corta solo si ayuda.",
  "Primer mensaje util despues de un audio de saludo: maximo 4 lineas. Deci: Kit Yoga Pro tiene 6 modulos con videos/audios. Base $14999. Completo $24999 con 3 bonus. Alias ofiprof.mp. Una pregunta corta al final.",
]);
migrateDefaultSetting("next_reply_prompt", DEFAULT_NEXT_REPLY_PROMPT, [
  LEGACY_NEXT_REPLY_PROMPT,
  LEGACY_HUMANIZED_NEXT_REPLY_PROMPT,
  "Ya hay conversacion previa. Responde en 1 a 3 lineas, segun contexto, y no repitas toda la presentacion salvo que la persona la pida.",
  "Ya hay conversacion previa. Responde como persona real en 1 o 2 lineas, con foco en organizacion de clases, plantillas listas, ahorro de tiempo y seguridad para enseñar. No lo lleves a práctica personal salvo que lo pidan. No uses signos de apertura. No menciones precios ni alias salvo que pregunten precio o como comprar.",
  "Ya hay conversacion previa. Responde como persona real en 1 o 2 lineas, con foco en organizacion de clases, plantillas listas, ahorro de tiempo y seguridad para enseñar. No lo lleves a práctica personal salvo que lo pidan. No uses signos de apertura. Si mencionas precio, siempre deci que por hoy esta $4999 y antes estaba $26999.",
  "Ya hay conversacion previa. Respondé como persona real en 1 o 2 lineas, con foco en organizacion de clases, plantillas listas, ahorro de tiempo y seguridad para enseñar. No repitas toda la presentacion salvo que la persona lo pida. No uses signos de apertura. Si mencionás precio, siempre decí $4.999 y antes $26.999. Si preguntan cómo pagar, pasá alias kit.yogapro a nombre de Nicolás Stamm.",
]);
migrateDefaultSetting("paid_reply_prompt", DEFAULT_PAID_REPLY_PROMPT, [
  "Esta persona ya compro el Kit Yoga Pro. Responde como soporte post-compra: ayuda con acceso, uso del material o dudas simples. No vendas, no ofrezcas descuentos y no repitas precios.",
]);
migrateDefaultSetting("followup_text", DEFAULT_FOLLOWUP_TEXT, [
  "Te dejamos una oportunidad para confirmar tu compra: el pack completo con los bonus por *$7999*.\n\nDepositás al alias *ofiprof.mp*, nos enviás el comprobante y te pasamos el link con todo el material.",
  "Te dejo una oportunidad para confirmar tu compra: el pack completo con los bonus por *$7999*. Depositás al alias *ofiprof.mp*, nos enviás el comprobante y te pasamos el link con todo el material.",
  "Te dejo una oportunidad para confirmar tu compra: solo por hoy el pack completo queda en *$4999* y antes estaba *$26999*. Depositás al alias *ofiprof.mp* a nombre de *Nicolás Stamm*, nos enviás el comprobante y te pasamos el link con todo el material.",
]);
migrateDefaultSetting("product_delivery_text", DEFAULT_PRODUCT_DELIVERY_TEXT, [
  `Pago confirmado ✅

Te dejo el acceso al material del *Kit Yoga Pro*:
{{product_access_url}}

Cualquier cosa, escribime por acá.`,
]);
migrateDefaultSetting("ask_name_text", DEFAULT_ASK_NAME_TEXT, [
  LEGACY_ASK_NAME_TEXT,
  "¡Hola! 👋 ¿Cómo te llamás?",
]);
migrateDefaultSetting("reminder_detail_text", DEFAULT_REMINDER_DETAIL_TEXT, []);
migrateDefaultSetting("reminder_product_description", DEFAULT_REMINDER_PRODUCT_DESCRIPTION, []);
migrateDefaultSetting("reminder2_offer_text", DEFAULT_REMINDER2_OFFER_TEXT, []);

for (const key of ["master_prompt", "followup_text", "first_reply_prompt", "next_reply_prompt", "followup_reminder_text"]) {
  replaceSettingText(key, "ofiprof.mp", "kit.yogapro");
}

// Price migration: $4.999 → $14.999 in all relevant settings
for (const key of ["master_prompt", "followup_text", "next_reply_prompt", "followup_reminder_text"]) {
  replaceSettingText(key, "$4.999", "$14.999");
  replaceSettingText(key, "$4999", "$14999");
}
replaceSettingText("master_prompt", "Solo por hoy $4.999", "Solo por hoy $14.999");
replaceSettingText("master_prompt", "siempre usá $4.999", "siempre usá $14.999");
replaceSettingText("next_reply_prompt", "siempre decí $4.999", "siempre decí $14.999");
replaceSettingText("followup_reminder_text", "oferta de $4.999", "oferta de $14.999");

// Bombazo price migration: catch ALL variants of 4999 → 6999
replaceSettingText("flash_offer_text", "$4.999", "$6.999");
replaceSettingText("flash_offer_text", "$4999", "$6999");
replaceSettingText("flash_offer_text", "4.999", "6.999");
replaceSettingText("flash_offer_text", "4999", "6999");

// INFO_PAYMENT_TEXT price migration
replaceSettingText("master_prompt", "respondiendo por WhatsApp a leads", "respondiendo por chat a leads");
replaceSettingText("first_reply_prompt", "tono humano de WhatsApp", "tono humano de chat");
replaceSettingText("next_reply_prompt", "tono humano de WhatsApp", "tono humano de chat");

updateSettings({ followup_enabled: "false" });
clearAllScheduledFollowUps();

db.prepare(
  `UPDATE contacts
   SET greeting_audio_sent = 1
   WHERE greeting_audio_sent = 0
     AND phone_number IN (
       SELECT phone_number
       FROM messages
        WHERE role = 'assistant'
          AND content IN ('¿Querés que te cuente sobre el Kit Yoga Pro?', 'Querés que te cuente sobre el Kit Yoga Pro?')
      )`
).run();

function nowIso() {
  return new Date().toISOString();
}

function resolveAttributionPhoneNumber(phoneNumber) {
  const value = String(phoneNumber ?? "").trim();
  if (!value || value.includes(":")) return value;

  const bare = value.replace(/^\+/, "");
  const plus = `+${bare}`;
  const plusContact = db.prepare("SELECT phone_number FROM contacts WHERE phone_number = ?").get(plus);

  if (plusContact) return plus;
  return value;
}

export function resolveChannelContactId(channel, accountId, externalId) {
  const prefix = channel === "facebook" ? "fb" : "ig";
  const external = String(externalId ?? "").trim();
  const account = String(accountId ?? "").trim();
  const legacyId = `${prefix}:${external}`;
  if (!account) return legacyId;

  const legacy = db.prepare("SELECT account_id AS accountId FROM contacts WHERE phone_number = ?").get(legacyId);
  if (legacy && (!legacy.accountId || legacy.accountId === account)) return legacyId;
  return `${prefix}:${account}:${external}`;
}

export function ensureContact(phoneNumber, details = {}) {
  const now = nowIso();
  const contactKey = normalizeContactKey(phoneNumber, details.accountId);
  const channel = details.channel ?? (String(phoneNumber).startsWith("ig:") ? "instagram" : String(phoneNumber).startsWith("fb:") ? "facebook" : "whatsapp");
  db.prepare(
    `INSERT OR IGNORE INTO contacts (phone_number, contact_key, conversation_id, channel, account_id, external_id, display_handle, conversation_url, name, attribution_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    phoneNumber,
    contactKey,
    details.conversationId ?? "",
    channel,
    details.accountId ?? "",
    details.externalId ?? "",
    details.displayHandle ?? "",
    details.conversationUrl ?? "",
    details.name ?? "",
    null,
    now,
    now
  );

  db.prepare(
    `UPDATE contacts
     SET contact_key = CASE WHEN ? != '' OR contact_key = '' THEN ? ELSE contact_key END,
          conversation_id = COALESCE(NULLIF(?, ''), conversation_id),
         channel = COALESCE(NULLIF(?, ''), channel),
         account_id = COALESCE(NULLIF(?, ''), account_id),
         external_id = COALESCE(NULLIF(?, ''), external_id),
         display_handle = COALESCE(NULLIF(?, ''), display_handle),
         conversation_url = COALESCE(NULLIF(?, ''), conversation_url),
         name = COALESCE(NULLIF(?, ''), name),
         updated_at = ?
     WHERE phone_number = ?`
  ).run(
    details.accountId ?? "",
    contactKey,
    details.conversationId ?? "",
    channel,
    details.accountId ?? "",
    details.externalId ?? "",
    details.displayHandle ?? "",
    details.conversationUrl ?? "",
    details.name ?? "",
    now,
    phoneNumber
  );
}

export function getContact(phoneNumber, details = {}) {
  ensureContact(phoneNumber, details);
  return db.prepare("SELECT * FROM contacts WHERE phone_number = ?").get(phoneNumber);
}

export function saveContactCtwaAttribution(phoneNumber, details = {}) {
  const contactPhoneNumber = resolveAttributionPhoneNumber(phoneNumber);
  ensureContact(contactPhoneNumber, details);
  const sourceId = String(details.ctwaSourceId ?? details.ctwa_source_id ?? "").trim();
  const clid = String(details.ctwaClid ?? details.ctwa_clid ?? "").trim();

  if (!sourceId && !clid) return false;

  const now = nowIso();
  db.prepare(
    `UPDATE contacts
     SET ctwa_clid = COALESCE(NULLIF(ctwa_clid, ''), ?),
         ctwa_source_id = COALESCE(NULLIF(ctwa_source_id, ''), ?),
         ctwa_source_url = COALESCE(NULLIF(ctwa_source_url, ''), ?),
         ctwa_headline = COALESCE(NULLIF(ctwa_headline, ''), ?),
          ctwa_source_type = COALESCE(NULLIF(ctwa_source_type, ''), ?),
          ctwa_captured_at = COALESCE(ctwa_captured_at, ?),
           attribution_at = COALESCE(attribution_at, ?, created_at),
         ctwa_raw_json = COALESCE(NULLIF(ctwa_raw_json, ''), ?),
         conversation_id = COALESCE(NULLIF(?, ''), conversation_id),
         account_id = COALESCE(NULLIF(?, ''), account_id),
         conversation_url = COALESCE(NULLIF(?, ''), conversation_url),
         updated_at = ?
     WHERE phone_number = ?`
  ).run(
    clid,
    sourceId,
    details.ctwaSourceUrl ?? details.ctwa_source_url ?? "",
    details.ctwaHeadline ?? details.ctwa_headline ?? "",
    details.ctwaSourceType ?? details.ctwa_source_type ?? "",
    details.ctwaCapturedAt ?? details.ctwa_captured_at ?? now,
    details.ctwaCapturedAt ?? details.ctwa_captured_at ?? now,
    details.rawJson ? JSON.stringify(details.rawJson) : "",
    details.conversationId ?? "",
    details.accountId ?? "",
    details.conversationUrl ?? "",
    now,
    contactPhoneNumber
  );

  return true;
}

export function listCtwaAttributedConversations(filters = {}) {
  const conditions = [
    "ctwa_source_id != ''",
    `NOT EXISTS (
       SELECT 1
       FROM contacts preferred
       WHERE preferred.ctwa_source_id != ''
         AND preferred.phone_number != contacts.phone_number
         AND preferred.phone_number LIKE '+%'
         AND contacts.phone_number NOT LIKE '+%'
          AND preferred.contact_key = contacts.contact_key
     )`,
  ];
  const params = [];
  const from = dateFilterStart(filters.from);
  const to = dateFilterEnd(filters.to);

  if (from) {
    conditions.push("attribution_at >= ?");
    params.push(from);
  }

  if (to) {
    conditions.push("attribution_at <= ?");
    params.push(to);
  }

  return measuredAll("sqlite.ctwa.conversations", db.prepare(
    `SELECT phone_number AS phoneNumber,
            conversation_id AS conversationId,
            account_id AS accountId,
            channel,
            name,
            display_handle AS displayHandle,
            paid,
            created_at AS createdAt,
            updated_at AS updatedAt,
            ctwa_clid AS ctwaClid,
            ctwa_source_id AS ctwaSourceId,
            ctwa_source_url AS ctwaSourceUrl,
            ctwa_headline AS ctwaHeadline,
            ctwa_source_type AS ctwaSourceType,
            ctwa_captured_at AS ctwaCapturedAt,
            COALESCE((SELECT SUM(amount) FROM payments WHERE contact_key = contacts.contact_key), 0) AS paymentTotal,
            COALESCE((SELECT COUNT(*) FROM payments WHERE contact_key = contacts.contact_key), 0) AS paymentCount,
            COALESCE((SELECT COUNT(*) FROM messages WHERE contact_key = contacts.contact_key AND role = 'user'), 0) AS leadReplyCount
     FROM contacts
     WHERE ${conditions.join(" AND ")}
     ORDER BY created_at DESC`
  ), params);
}

export function listCtwaAttributedPayments(filters = {}) {
  const conditions = [];
  const params = [];
  const from = dateFilterStart(filters.from);
  const to = dateFilterEnd(filters.to);

  if (from) {
    conditions.push("p.paid_at >= ?");
    params.push(from);
  }

  if (to) {
    conditions.push("p.paid_at <= ?");
    params.push(to);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  return measuredAll("sqlite.ctwa.payments", db.prepare(
    `WITH attributed_contacts AS (
       SELECT c.*
       FROM contacts c
       WHERE c.ctwa_source_id != ''
         AND NOT EXISTS (
           SELECT 1
           FROM contacts preferred
           WHERE preferred.ctwa_source_id != ''
             AND preferred.phone_number != c.phone_number
             AND preferred.phone_number LIKE '+%'
             AND c.phone_number NOT LIKE '+%'
              AND preferred.contact_key = c.contact_key
         )
     ), matched_payments AS (
       SELECT p.id,
              p.phone_number AS phoneNumber,
              p.product_code AS productCode,
              p.product_name AS productName,
              p.amount,
              p.discount,
              p.note,
              p.paid_at AS paidAt,
              p.created_at AS createdAt,
              c.phone_number AS attributedPhoneNumber,
              c.channel,
              c.account_id AS accountId,
              c.conversation_id AS conversationId,
              c.display_handle AS displayHandle,
              c.ctwa_source_id AS ctwaSourceId,
              c.ctwa_source_url AS ctwaSourceUrl,
              c.ctwa_headline AS ctwaHeadline,
              c.ctwa_source_type AS ctwaSourceType,
              c.ctwa_captured_at AS ctwaCapturedAt,
              ROW_NUMBER() OVER (
                PARTITION BY p.id
                ORDER BY CASE
                  WHEN p.phone_number = c.phone_number THEN 0
                  WHEN c.phone_number LIKE '+%' THEN 1
                  ELSE 2
                END
              ) AS matchRank
       FROM payments p
        JOIN attributed_contacts c ON p.contact_key = c.contact_key
       ${where}
     )
     SELECT *
     FROM matched_payments
     WHERE matchRank = 1
     ORDER BY paidAt DESC, id DESC`
  ), params);
}

export function listCtwaCohortAttributedPayments(filters = {}) {
  const conditions = [];
  const params = [];
  const from = dateFilterStart(filters.from);
  const to = dateFilterEnd(filters.to);

  if (from) {
    conditions.push("c.attribution_at >= ?");
    params.push(from);
  }

  if (to) {
    conditions.push("c.attribution_at <= ?");
    params.push(to);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  return measuredAll("sqlite.ctwa.cohort_payments", db.prepare(
    `WITH attributed_contacts AS (
       SELECT c.*
       FROM contacts c
       WHERE c.ctwa_source_id != ''
         AND NOT EXISTS (
           SELECT 1
           FROM contacts preferred
           WHERE preferred.ctwa_source_id != ''
             AND preferred.phone_number != c.phone_number
             AND preferred.phone_number LIKE '+%'
             AND c.phone_number NOT LIKE '+%'
              AND preferred.contact_key = c.contact_key
         )
     ), matched_payments AS (
       SELECT p.id,
              p.phone_number AS phoneNumber,
              p.product_code AS productCode,
              p.product_name AS productName,
              p.amount,
              p.discount,
              p.note,
              p.paid_at AS paidAt,
              p.created_at AS createdAt,
              c.phone_number AS attributedPhoneNumber,
              c.channel,
              c.account_id AS accountId,
              c.conversation_id AS conversationId,
              c.display_handle AS displayHandle,
              c.ctwa_source_id AS ctwaSourceId,
              c.ctwa_source_url AS ctwaSourceUrl,
              c.ctwa_headline AS ctwaHeadline,
              c.ctwa_source_type AS ctwaSourceType,
              c.ctwa_captured_at AS ctwaCapturedAt,
               c.attribution_at AS leadAt,
              ROW_NUMBER() OVER (
                PARTITION BY p.id
                ORDER BY CASE
                  WHEN p.phone_number = c.phone_number THEN 0
                  WHEN c.phone_number LIKE '+%' THEN 1
                  ELSE 2
                END
              ) AS matchRank
       FROM payments p
        JOIN attributed_contacts c ON p.contact_key = c.contact_key
       ${where}
     )
     SELECT *
     FROM matched_payments
     WHERE matchRank = 1
     ORDER BY leadAt DESC, paidAt DESC, id DESC`
  ), params);
}

export function listCtwaHourlyStats(filters = {}) {
  const from = dateFilterStart(filters.from);
  const to = dateFilterEnd(filters.to);
  const salesConditions = [];
  const salesParams = [];
  const replyConditions = ["m.role = 'user'"];
  const replyParams = [];

  if (from) {
    salesConditions.push("c.attribution_at >= ?");
    salesParams.push(from);
    replyConditions.push("m.at >= ?");
    replyParams.push(from);
  }

  if (to) {
    salesConditions.push("c.attribution_at <= ?");
    salesParams.push(to);
    replyConditions.push("m.at <= ?");
    replyParams.push(to);
  }

  const salesWhere = salesConditions.length ? `WHERE ${salesConditions.join(" AND ")}` : "";
  const replyWhere = replyConditions.length ? `WHERE ${replyConditions.join(" AND ")}` : "";

  const sales = measuredAll("sqlite.ctwa.hourly_sales", db.prepare(
    `WITH attributed_contacts AS (
       SELECT c.*
       FROM contacts c
       WHERE c.ctwa_source_id != ''
         AND NOT EXISTS (
           SELECT 1
           FROM contacts preferred
           WHERE preferred.ctwa_source_id != ''
             AND preferred.phone_number != c.phone_number
             AND preferred.phone_number LIKE '+%'
             AND c.phone_number NOT LIKE '+%'
              AND preferred.contact_key = c.contact_key
         )
     ), matched_sales AS (
       SELECT p.id,
               c.attribution_at AS at,
              p.amount,
              ROW_NUMBER() OVER (
                PARTITION BY p.id
                ORDER BY CASE
                  WHEN p.phone_number = c.phone_number THEN 0
                  WHEN c.phone_number LIKE '+%' THEN 1
                  ELSE 2
                END
              ) AS matchRank
       FROM payments p
        JOIN attributed_contacts c ON p.contact_key = c.contact_key
       ${salesWhere}
     )
     SELECT id, at, amount
     FROM matched_sales
     WHERE matchRank = 1
     ORDER BY at ASC`
  ), salesParams);

  const replies = measuredAll("sqlite.ctwa.hourly_replies", db.prepare(
    `SELECT first_user_at AS at,
            user_messages AS userMessages
     FROM (
        SELECT m.contact_key,
              MIN(m.at) AS first_user_at,
              COUNT(*) AS user_messages
       FROM messages m
       ${replyWhere}
        GROUP BY m.contact_key
     ) reply
     WHERE EXISTS (
       SELECT 1
       FROM contacts c
       WHERE c.ctwa_source_id != ''
          AND c.contact_key = reply.contact_key
     )
     ORDER BY first_user_at ASC`
  ), replyParams);

  return { sales, replies };
}

export function getHistory(phoneNumber) {
  ensureContact(phoneNumber);

  return db
    .prepare(
      `SELECT role, content
       FROM messages
       WHERE phone_number = ?
       ORDER BY id DESC
       LIMIT 20`
    )
    .all(phoneNumber)
    .reverse();
}

export function addMessage(phoneNumber, role, content, details = {}) {
  ensureContact(phoneNumber, details);

  const now = nowIso();
  const contactKey = db.prepare("SELECT contact_key AS contactKey FROM contacts WHERE phone_number = ?").get(phoneNumber)?.contactKey
    ?? normalizeContactKey(phoneNumber, details.accountId);
  db.prepare("INSERT INTO messages (phone_number, contact_key, role, content, at) VALUES (?, ?, ?, ?, ?)").run(
    phoneNumber,
    contactKey,
    role,
    content,
    now
  );

  if (role === "user") {
    db.prepare(
      "UPDATE contacts SET last_incoming_at = ?, conversation_id = COALESCE(NULLIF(?, ''), conversation_id), updated_at = ? WHERE phone_number = ?"
    ).run(now, details.conversationId ?? "", now, phoneNumber);
  } else {
    db.prepare("UPDATE contacts SET updated_at = ? WHERE phone_number = ?").run(now, phoneNumber);
  }
}

export function clearHistory(phoneNumber) {
  ensureContact(phoneNumber);
  db.prepare("DELETE FROM messages WHERE phone_number = ?").run(phoneNumber);
  db.prepare(
    `UPDATE contacts
     SET handoff = 0,
         handoff_reason = '',
         handoff_last_message = '',
         greeting_sent = 0,
          greeting_audio_sent = 0,
          material_preview_offered = 0,
          material_video_sent = 0,
          name = '',
          name_asked = 0,
          promo_scheduled_at = NULL,
          reminder_scheduled_at = NULL,
          reminder_attempted_at = NULL,
          reminder_sent_at = NULL,
          reminder2_scheduled_at = NULL,
          reminder2_attempted_at = NULL,
          reminder2_sent_at = NULL,
          updated_at = ?
     WHERE phone_number = ?`
  ).run(nowIso(), phoneNumber);
}

export function markGreetingSent(phoneNumber) {
  ensureContact(phoneNumber);
  db.prepare("UPDATE contacts SET greeting_sent = 1, updated_at = ? WHERE phone_number = ?").run(
    nowIso(),
    phoneNumber
  );
}

export function hasGreetingBeenSent(phoneNumber) {
  return Boolean(getContact(phoneNumber).greeting_sent);
}

export function markGreetingAudioSent(phoneNumber) {
  ensureContact(phoneNumber);
  db.prepare("UPDATE contacts SET greeting_audio_sent = 1, updated_at = ? WHERE phone_number = ?").run(
    nowIso(),
    phoneNumber
  );
}

export function hasGreetingAudioBeenSent(phoneNumber) {
  return Boolean(getContact(phoneNumber).greeting_audio_sent);
}

export function markMaterialPreviewOffered(phoneNumber) {
  ensureContact(phoneNumber);
  db.prepare("UPDATE contacts SET material_preview_offered = 1, updated_at = ? WHERE phone_number = ?").run(
    nowIso(),
    phoneNumber
  );
}

export function hasMaterialPreviewBeenOffered(phoneNumber) {
  return Boolean(getContact(phoneNumber).material_preview_offered);
}

export function markMaterialVideoSent(phoneNumber) {
  ensureContact(phoneNumber);
  const now = nowIso();
  db.prepare("UPDATE contacts SET material_video_sent = 1, material_video_sent_at = COALESCE(material_video_sent_at, ?), updated_at = ? WHERE phone_number = ?").run(
    now,
    now,
    phoneNumber
  );
}

export function hasMaterialVideoBeenSent(phoneNumber) {
  return Boolean(getContact(phoneNumber).material_video_sent);
}

export function getMaterialVideoSentAt(phoneNumber) {
  return getContact(phoneNumber).material_video_sent_at || "";
}

export function saveContactName(phoneNumber, name) {
  ensureContact(phoneNumber);
  db.prepare("UPDATE contacts SET name = ?, updated_at = ? WHERE phone_number = ?").run(
    name.trim(),
    nowIso(),
    phoneNumber
  );
}

export function hasNameBeenAsked(phoneNumber) {
  return Boolean(getContact(phoneNumber).name_asked);
}

export function markNameAsked(phoneNumber) {
  ensureContact(phoneNumber);
  db.prepare("UPDATE contacts SET name_asked = 1, updated_at = ? WHERE phone_number = ?").run(
    nowIso(),
    phoneNumber
  );
}

export function getContactName(phoneNumber) {
  return getContact(phoneNumber).name || "";
}

export function deleteContact(phoneNumber) {
  db.prepare("DELETE FROM contacts WHERE phone_number = ?").run(phoneNumber);
}

export function requestHumanHandoff(phoneNumber, details = {}) {
  ensureContact(phoneNumber, details);
  db.prepare(
    `UPDATE contacts
     SET handoff = 1,
          handoff_reason = ?,
          handoff_last_message = ?,
          conversation_id = COALESCE(NULLIF(?, ''), conversation_id),
          promo_scheduled_at = NULL,
          reminder_scheduled_at = NULL,
          updated_at = ?
     WHERE phone_number = ?`
  ).run(
    details.reason ?? "human_review",
    details.lastMessage ?? "",
    details.conversationId ?? "",
    nowIso(),
    phoneNumber
  );
}

export function isHumanHandoffRequested(phoneNumber) {
  return Boolean(getContact(phoneNumber).handoff);
}

export function resolveHumanHandoff(phoneNumber) {
  ensureContact(phoneNumber);
  const result = db
    .prepare(
      `UPDATE contacts
       SET handoff = 0,
           handoff_reason = '',
           handoff_last_message = '',
           updated_at = ?
       WHERE phone_number = ?`
    )
    .run(nowIso(), phoneNumber);

  return result.changes > 0;
}

export function markContactPaid(phoneNumber, paid = true, details = {}) {
  ensureContact(phoneNumber);
  const now = details.paidAt ?? nowIso();
  db.prepare(
    `UPDATE contacts
     SET paid = ?,
          paid_at = CASE WHEN ? = 1 THEN COALESCE(paid_at, ?) ELSE NULL END,
          promo_scheduled_at = CASE WHEN ? = 1 THEN NULL ELSE promo_scheduled_at END,
          reminder_scheduled_at = CASE WHEN ? = 1 THEN NULL ELSE reminder_scheduled_at END,
          reminder2_scheduled_at = CASE WHEN ? = 1 THEN NULL ELSE reminder2_scheduled_at END,
          handoff = CASE WHEN ? = 1 THEN 0 ELSE handoff END,
          updated_at = ?
       WHERE phone_number = ?`
  ).run(paid ? 1 : 0, paid ? 1 : 0, now, paid ? 1 : 0, paid ? 1 : 0, paid ? 1 : 0, paid ? 1 : 0, now, phoneNumber);
}

export function recordPayment(phoneNumber, details = {}) {
  ensureContact(phoneNumber, { conversationId: details.conversationId });

  const now = nowIso();
  const paidAt = details.paidAt ?? now;
  const amount = Math.max(0, Number.parseInt(details.amount ?? 0, 10) || 0);
  const discount = Math.max(0, Number.parseInt(details.discount ?? 0, 10) || 0);
  const productCode = String(details.productCode ?? "base").trim() || "base";
  const productName = String(details.productName ?? "Kit Yoga Pro").trim() || "Kit Yoga Pro";
  const note = String(details.note ?? "").trim();
  const contactKey = db.prepare("SELECT contact_key AS contactKey FROM contacts WHERE phone_number = ?").get(phoneNumber)?.contactKey
    ?? normalizeContactKey(phoneNumber, details.accountId);

  const result = db
    .prepare(
      `INSERT INTO payments (phone_number, contact_key, product_code, product_name, amount, discount, note, paid_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(phoneNumber, contactKey, productCode, productName, amount, discount, note, paidAt, now);

  markContactPaid(phoneNumber, true, { paidAt });

  return result.lastInsertRowid;
}

export function reverseLatestPayment(phoneNumber) {
  const contact = String(phoneNumber ?? "").trim();
  if (!contact) return null;

  db.exec("BEGIN IMMEDIATE");
  try {
    const payment = db.prepare(
      `SELECT id, amount, paid_at AS paidAt
       FROM payments
       WHERE phone_number = ?
       ORDER BY paid_at DESC, id DESC
       LIMIT 1`
    ).get(contact);
    if (!payment) {
      db.exec("COMMIT");
      return null;
    }

    db.prepare("DELETE FROM payments WHERE id = ?").run(payment.id);
    const remaining = db.prepare(
      `SELECT paid_at AS paidAt
       FROM payments
       WHERE phone_number = ?
       ORDER BY paid_at DESC, id DESC
       LIMIT 1`
    ).get(contact);
    db.prepare(
      `UPDATE contacts
       SET paid = ?,
           paid_at = ?,
           updated_at = ?
       WHERE phone_number = ?`
    ).run(remaining ? 1 : 0, remaining?.paidAt ?? null, nowIso(), contact);
    db.exec("COMMIT");
    return { paymentId: payment.id, amount: payment.amount, paidAt: payment.paidAt, stillPaid: Boolean(remaining) };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function markProductLinkSent(phoneNumber) {
  ensureContact(phoneNumber);
  const now = nowIso();
  db.prepare(
    `UPDATE contacts
     SET product_link_sent = 1,
         product_link_sent_at = COALESCE(product_link_sent_at, ?),
         updated_at = ?
     WHERE phone_number = ?`
  ).run(now, now, phoneNumber);
}

export function listHumanHandoffs() {
  return db
    .prepare(
      `SELECT phone_number AS phoneNumber,
              channel AS channel,
              account_id AS accountId,
              display_handle AS displayHandle,
              conversation_url AS conversationUrl,
              handoff_reason AS reason,
              handoff_last_message AS lastMessage,
              conversation_id AS conversationId,
              updated_at AS updatedAt,
              created_at AS createdAt
       FROM contacts
       WHERE handoff = 1
       ORDER BY updated_at DESC`
    )
    .all();
}

export function listActiveConversations() {
  return db.prepare("SELECT phone_number FROM contacts ORDER BY updated_at DESC").all().map((row) => row.phone_number);
}

export function getAdminRevision(today = "") {
  const todayStart = dateFilterStart(today);
  const todayEnd = dateFilterEnd(today);
  return measuredGet("sqlite.admin.revision", db.prepare(
    `SELECT (SELECT COUNT(*) FROM contacts) AS conversations,
            (SELECT COUNT(*) FROM contacts WHERE handoff = 1) AS handoffs,
            (SELECT COUNT(*) FROM payments) AS payments,
            COALESCE((SELECT SUM(amount) FROM payments), 0) AS paymentTotal,
            (SELECT COUNT(*) FROM payments WHERE paid_at >= ? AND paid_at <= ?) AS todayPayments,
            (SELECT COUNT(*) FROM contacts WHERE created_at >= ? AND created_at <= ?) AS todayConversations,
            COALESCE((SELECT MAX(updated_at) FROM meta_ads_daily_metrics), '') AS metaUpdatedAt,
            COALESCE((SELECT MAX(updated_at) FROM contacts), '') AS updatedAt`
  ), [todayStart, todayEnd, todayStart, todayEnd]);
}

function conversationSummaryFilter(options = {}) {
  const conditions = [];
  const params = [];
  const filter = String(options.filter ?? "all");
  const search = String(options.search ?? "").trim();
  const quickFilter = String(options.quickFilter ?? "all");
  const from = dateFilterStart(options.createdFrom);
  const to = dateFilterEnd(options.createdTo);
  const activityFrom = dateFilterStart(options.activityFrom);
  const activityTo = dateFilterEnd(options.activityTo);

  if (filter === "converted") conditions.push("c.paid = 1");
  if (filter === "pending") conditions.push("c.paid = 0");
  if (filter === "interested") {
    conditions.push("(SELECT COUNT(*) FROM messages interested_messages WHERE interested_messages.phone_number = c.phone_number AND interested_messages.role = 'user') >= 2");
  }
  if (quickFilter === "handoff") conditions.push("c.handoff = 1");
  if (quickFilter === "bot") conditions.push("c.handoff = 0 AND c.paid = 0");
  if (["instagram", "facebook", "whatsapp"].includes(quickFilter)) {
    conditions.push("c.channel = ?");
    params.push(quickFilter);
  }
  if (quickFilter === "released") conditions.push("(c.promo_sent = 1 OR c.product_link_sent = 1)");
  if (quickFilter === "access-pending") conditions.push("c.product_link_sent = 0");
  if (quickFilter === "unpaid") conditions.push("c.paid = 0");
  if (["interest-1", "interest-2", "interest-3plus"].includes(quickFilter)) {
    const operator = quickFilter === "interest-3plus" ? ">=" : "=";
    const amount = quickFilter === "interest-1" ? 1 : quickFilter === "interest-2" ? 2 : 3;
    conditions.push(`(SELECT COUNT(*) FROM messages interest_messages WHERE interest_messages.phone_number = c.phone_number AND interest_messages.role = 'user') ${operator} ?`);
    params.push(amount);
  }
  if (activityFrom) {
    conditions.push("c.updated_at >= ?");
    params.push(activityFrom);
  }
  if (activityTo) {
    conditions.push("c.updated_at <= ?");
    params.push(activityTo);
  }
  if (from) {
    conditions.push("c.created_at >= ?");
    params.push(from);
  }
  if (to) {
    conditions.push("c.created_at <= ?");
    params.push(to);
  }
  if (search) {
    let textSearch = search;
    const semanticConditions = [];
    const consume = (pattern, condition) => {
      if (!pattern.test(textSearch)) return false;
      textSearch = textSearch.replace(pattern, " ");
      semanticConditions.push(condition);
      return true;
    };
    if (!consume(/sin pago/gi, "c.paid = 0")) consume(/cliente (?:pago|completo)|convertid[oa]?|venta|^\s*pago\s*$/gi, "c.paid = 1");
    consume(/revisi[oó]n|pausad[oa]?/gi, "c.handoff = 1");
    consume(/bot activo/gi, "c.handoff = 0 AND c.paid = 0");
    consume(/producto liberado|acceso enviado|liberad[oa]?/gi, "c.product_link_sent = 1 OR c.promo_sent = 1");
    consume(/acceso pendiente/gi, "c.product_link_sent = 0");
    if (!consume(/sin recordatorio/gi, "c.reminder_scheduled_at IS NULL")) consume(/recordatorio/gi, "c.reminder_scheduled_at IS NOT NULL");
    if (!consume(/muy interesado|3\+ respuestas/gi, "(SELECT COUNT(*) FROM messages search_interest WHERE search_interest.phone_number = c.phone_number AND search_interest.role = 'user') >= 3")) {
      if (!consume(/interesad[oa]?|2 respuestas/gi, "(SELECT COUNT(*) FROM messages search_interest WHERE search_interest.phone_number = c.phone_number AND search_interest.role = 'user') >= 2")) {
        consume(/inter[eé]s inicial|1 respuesta/gi, "(SELECT COUNT(*) FROM messages search_interest WHERE search_interest.phone_number = c.phone_number AND search_interest.role = 'user') = 1");
      }
    }
    consume(/sin respuesta/gi, "(SELECT COUNT(*) FROM messages search_interest WHERE search_interest.phone_number = c.phone_number AND search_interest.role = 'user') = 0");
    consume(/tibio/gi, "(SELECT COUNT(*) FROM messages search_interest WHERE search_interest.phone_number = c.phone_number AND search_interest.role = 'user') = 1");
    conditions.push(...semanticConditions.map((condition) => `(${condition})`));
    textSearch = textSearch.replace(/\s+/g, " ").trim();
    if (!textSearch) return { where: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "", params };

    const escapedSearch = textSearch.replace(/[\\%_]/g, "\\$&");
    const term = `%${escapedSearch}%`;
    const searchClauses = [
      "c.phone_number LIKE ? ESCAPE '\\' COLLATE NOCASE",
      "c.name LIKE ? ESCAPE '\\' COLLATE NOCASE",
      "c.display_handle LIKE ? ESCAPE '\\' COLLATE NOCASE",
      "c.external_id LIKE ? ESCAPE '\\' COLLATE NOCASE",
      "c.channel LIKE ? ESCAPE '\\' COLLATE NOCASE",
      "c.ctwa_headline LIKE ? ESCAPE '\\' COLLATE NOCASE",
      "c.ctwa_source_id LIKE ? ESCAPE '\\' COLLATE NOCASE",
      "c.ctwa_source_url LIKE ? ESCAPE '\\' COLLATE NOCASE",
      "EXISTS (SELECT 1 FROM messages search_messages WHERE search_messages.phone_number = c.phone_number AND search_messages.content LIKE ? ESCAPE '\\' COLLATE NOCASE)",
      "EXISTS (SELECT 1 FROM payments search_payments WHERE search_payments.phone_number = c.phone_number AND (search_payments.product_name LIKE ? ESCAPE '\\' COLLATE NOCASE OR CAST(search_payments.amount AS TEXT) LIKE ? ESCAPE '\\'))",
    ];
    params.push(term, term, term, term, term, term, term, term, term, term, term);
    conditions.push(`(${searchClauses.join(" OR ")})`);
  }

  return { where: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "", params };
}

export function countConversationSummaries(options = {}) {
  const { where, params } = conversationSummaryFilter(options);
  return measuredGet("sqlite.admin.conversation_count", db.prepare(`SELECT COUNT(*) AS total FROM contacts c ${where}`), params)?.total ?? 0;
}

export function listConversationSummaries(options = {}) {
  const { where, params } = conversationSummaryFilter(options);
  const hasLimit = Number.isInteger(options.limit) && options.limit > 0;
  const limit = hasLimit ? Math.min(options.limit, 200) : null;
  const offset = hasLimit ? Math.max(0, Number.parseInt(options.offset ?? 0, 10) || 0) : 0;
  const pagination = hasLimit ? "LIMIT ? OFFSET ?" : "";
  const queryParams = hasLimit ? [...params, limit, offset] : params;
  const order = options.prioritizeConversions
    ? `ORDER BY CASE WHEN c.paid = 1 THEN 0 ELSE 1 END,
              CASE WHEN c.paid = 1 THEN COALESCE(c.paid_at, c.updated_at) ELSE c.updated_at END DESC,
              c.phone_number ASC`
    : "ORDER BY c.updated_at DESC, c.phone_number ASC";

  return measuredAll("sqlite.admin.conversation_page", db.prepare(
      `WITH filtered_contacts AS (
         SELECT c.*
         FROM contacts c
         ${where}
         ${order}
         ${pagination}
       ),
       message_stats AS (
         SELECT m.phone_number AS phone_number,
                COUNT(*) AS message_count,
                SUM(CASE WHEN role = 'user' THEN 1 ELSE 0 END) AS lead_reply_count,
                MAX(id) AS last_message_id
         FROM messages m
         INNER JOIN filtered_contacts fc ON fc.phone_number = m.phone_number
         GROUP BY m.phone_number
       ),
       payment_stats AS (
         SELECT p.phone_number,
                p.product_name,
                p.amount,
                p.paid_at,
                SUM(p.amount) OVER (PARTITION BY p.phone_number) AS payment_total,
                COUNT(*) OVER (PARTITION BY p.phone_number) AS payment_count,
                ROW_NUMBER() OVER (PARTITION BY p.phone_number ORDER BY p.paid_at DESC, p.id DESC) AS payment_rank
         FROM payments p
         INNER JOIN filtered_contacts fc ON fc.phone_number = p.phone_number
       )
       SELECT c.phone_number AS phoneNumber,
                c.name AS name,
               c.conversation_id AS conversationId,
               c.channel AS channel,
               c.account_id AS accountId,
               c.external_id AS externalId,
               c.display_handle AS displayHandle,
                c.conversation_url AS conversationUrl,
                c.ctwa_source_id AS ctwaSourceId,
                c.ctwa_source_url AS ctwaSourceUrl,
                c.ctwa_headline AS ctwaHeadline,
                c.ctwa_captured_at AS ctwaCapturedAt,
                c.paid AS paid,
               c.paid_at AS paidAt,
               c.product_link_sent AS productLinkSent,
               c.product_link_sent_at AS productLinkSentAt,
               c.handoff AS handoff,
              c.greeting_sent AS greetingSent,
               c.name_asked AS nameAsked,
               c.promo_scheduled_at AS promoScheduledAt,
               c.promo_sent AS promoSent,
               c.promo_sent_at AS promoSentAt,
               c.reminder_scheduled_at AS reminderScheduledAt,
               c.reminder_sent_at AS reminderSentAt,
               c.last_incoming_at AS lastIncomingAt,
               c.created_at AS createdAt,
               c.updated_at AS updatedAt,
                COALESCE(ms.message_count, 0) AS messageCount,
                COALESCE(ms.lead_reply_count, 0) AS leadReplyCount,
                COALESCE(ps.payment_total, 0) AS paymentTotal,
                COALESCE(ps.payment_count, 0) AS paymentCount,
                ps.product_name AS latestPaymentProduct,
                ps.amount AS latestPaymentAmount,
                ps.paid_at AS latestPaymentAt,
                lm.content AS lastMessage
        FROM filtered_contacts c
        LEFT JOIN message_stats ms ON ms.phone_number = c.phone_number
        LEFT JOIN messages lm ON lm.id = ms.last_message_id
        LEFT JOIN payment_stats ps ON ps.phone_number = c.phone_number AND ps.payment_rank = 1
        ${order}`
    ), queryParams);
}

function dateFilterStart(value) {
  if (!isBusinessDateKey(value)) return null;
  return businessDateRange(value).start.toISOString();
}

function dateFilterEnd(value) {
  if (!isBusinessDateKey(value)) return null;
  return businessDateRange(value).end.toISOString();
}

export function listPayments(filters = {}) {
  const conditions = [];
  const params = [];
  const from = dateFilterStart(filters.from);
  const to = dateFilterEnd(filters.to);

  if (from) {
    conditions.push("paid_at >= ?");
    params.push(from);
  }

  if (to) {
    conditions.push("paid_at <= ?");
    params.push(to);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const hasLimit = Number.isInteger(filters.limit) && filters.limit > 0;
  const pagination = hasLimit ? "LIMIT ? OFFSET ?" : "";
  if (hasLimit) {
    params.push(Math.min(filters.limit, 200), Math.max(0, Number.parseInt(filters.offset ?? 0, 10) || 0));
  }

  return measuredAll("sqlite.admin.payments", db.prepare(
      `SELECT id,
              phone_number AS phoneNumber,
              product_code AS productCode,
              product_name AS productName,
              amount,
              discount,
              note,
              paid_at AS paidAt,
              created_at AS createdAt
       FROM payments
       ${where}
       ORDER BY paid_at DESC, id DESC
       ${pagination}`
    ), params);
}

export function listRecentPaidContactsMissingCtwaAttribution(options = {}) {
  const limit = Math.min(100, Math.max(1, Number(options.limit) || 50));
  const since = String(options.since ?? "").trim();
  if (!since) return [];

  return measuredAll("sqlite.ctwa.recovery_candidates", db.prepare(
    `WITH recent_payments AS (
       SELECT contact_key, MAX(paid_at) AS paid_at
       FROM payments
       WHERE paid_at >= ?
       GROUP BY contact_key
     )
     SELECT c.phone_number AS phoneNumber,
            c.conversation_id AS conversationId,
            c.account_id AS accountId,
            c.channel,
            c.ctwa_source_id AS ctwaSourceId
     FROM recent_payments rp
     JOIN contacts c ON c.contact_key = rp.contact_key
     WHERE c.paid = 1
       AND c.ctwa_source_id = ''
       AND c.conversation_id != ''
     ORDER BY rp.paid_at DESC
     LIMIT ?`
  ), [since, limit]);
}

export function getAdSpend(date) {
  const key = String(date ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return { date: key, amount: 0, note: "", updatedAt: "" };

  const row = db
    .prepare(
      `SELECT date,
              amount,
              note,
              updated_at AS updatedAt
       FROM ad_spend
       WHERE date = ?`
    )
    .get(key);

  return row ?? { date: key, amount: 0, note: "", updatedAt: "" };
}

export function listAdSpendRange(filters = {}) {
  const conditions = [];
  const params = [];
  const from = String(filters.from ?? "").trim();
  const to = String(filters.to ?? "").trim();

  if (/^\d{4}-\d{2}-\d{2}$/.test(from)) {
    conditions.push("date >= ?");
    params.push(from);
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    conditions.push("date <= ?");
    params.push(to);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  return db
    .prepare(
      `SELECT date,
              amount,
              note,
              updated_at AS updatedAt
       FROM ad_spend
       ${where}
       ORDER BY date ASC`
    )
    .all(...params);
}

export function upsertAdSpend(date, details = {}) {
  const key = String(date ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return false;

  const amount = Math.max(0, Number.parseInt(details.amount ?? 0, 10) || 0);
  const note = String(details.note ?? "").trim();
  const now = nowIso();

  db.prepare(
    `INSERT INTO ad_spend (date, amount, note, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET
       amount = excluded.amount,
       note = excluded.note,
       updated_at = excluded.updated_at`
  ).run(key, amount, note, now);

  return true;
}

export function upsertMetaAdsDailyMetrics(date, metrics = {}) {
  const key = String(date ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return false;

  const now = nowIso();
  db.prepare(
     `INSERT INTO meta_ads_daily_metrics (
       date, ad_account_id, ad_account_name, account_id, spend, impressions, clicks, cpc, cpm, conversions,
       purchase_value, roas, currency, usd_ars_rate, source, raw_json, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(date, ad_account_id) DO UPDATE SET
       ad_account_name = excluded.ad_account_name,
       account_id = excluded.account_id,
       spend = excluded.spend,
       impressions = excluded.impressions,
       clicks = excluded.clicks,
       cpc = excluded.cpc,
       cpm = excluded.cpm,
       conversions = excluded.conversions,
       purchase_value = excluded.purchase_value,
       roas = excluded.roas,
       currency = excluded.currency,
       usd_ars_rate = excluded.usd_ars_rate,
       source = excluded.source,
       raw_json = excluded.raw_json,
       updated_at = excluded.updated_at`
  ).run(
    key,
    String(metrics.adAccountId ?? "").trim(),
    String(metrics.adAccountName ?? "").trim(),
    String(metrics.accountId ?? "").trim(),
    Number(metrics.spend) || 0,
    Math.max(0, Number.parseInt(metrics.impressions ?? 0, 10) || 0),
    Math.max(0, Number.parseInt(metrics.clicks ?? 0, 10) || 0),
    Number(metrics.cpc) || 0,
    Number(metrics.cpm) || 0,
    Math.max(0, Number.parseInt(metrics.conversions ?? 0, 10) || 0),
    Number(metrics.purchaseValue) || 0,
    Number(metrics.roas) || 0,
    String(metrics.currency ?? "").trim(),
    Math.max(0, Number(metrics.usdArsRate) || 0),
    String(metrics.source ?? "zernio").trim() || "zernio",
    metrics.rawJson ? JSON.stringify(metrics.rawJson) : "",
    now
  );

  return true;
}

export function getMetaAdsDailyMetrics(date, adAccountId = "") {
  const key = String(date ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return null;
  const accountKey = String(adAccountId ?? "").trim();
  if (!accountKey) return null;

  return db
    .prepare(
       `SELECT date,
               ad_account_id AS adAccountId,
               ad_account_name AS adAccountName,
               account_id AS accountId,
              spend,
              impressions,
              clicks,
              cpc,
              cpm,
              conversions,
              purchase_value AS purchaseValue,
              roas,
               currency,
               usd_ars_rate AS usdArsRate,
              source,
              raw_json AS rawJson,
              updated_at AS updatedAt
       FROM meta_ads_daily_metrics
        WHERE date = ? AND ad_account_id = ?`
    )
    .get(key, accountKey) ?? null;
}

export function listMetaAdsDailyMetricsRange(filters = {}) {
  const conditions = [];
  const params = [];
  const from = String(filters.from ?? "").trim();
  const to = String(filters.to ?? "").trim();
  const adAccountId = String(filters.adAccountId ?? "").trim();

  if (!adAccountId) return [];
  conditions.push("ad_account_id = ?");
  params.push(adAccountId);

  if (/^\d{4}-\d{2}-\d{2}$/.test(from)) {
    conditions.push("date >= ?");
    params.push(from);
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    conditions.push("date <= ?");
    params.push(to);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  return db
    .prepare(
      `SELECT date,
               ad_account_id AS adAccountId,
               ad_account_name AS adAccountName,
               account_id AS accountId,
              spend,
              impressions,
              clicks,
              cpc,
              cpm,
              conversions,
              purchase_value AS purchaseValue,
              roas,
               currency,
               usd_ars_rate AS usdArsRate,
              source,
              raw_json AS rawJson,
              updated_at AS updatedAt
       FROM meta_ads_daily_metrics
       ${where}
       ORDER BY date ASC`
    )
    .all(...params);
}

export function listUnassignedMetaAdsMetrics() {
  return db
    .prepare(
      `SELECT date, spend, impressions, clicks, conversions, purchase_value AS purchaseValue
       FROM meta_ads_daily_metrics
       WHERE ad_account_id = ''
       ORDER BY date ASC`
    )
    .all();
}

export function deleteUnassignedMetaAdsDailyMetrics(date) {
  const key = String(date ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return false;
  return db.prepare("DELETE FROM meta_ads_daily_metrics WHERE date = ? AND ad_account_id = ''").run(key).changes > 0;
}

export function deleteMetaAdsDailyMetrics(date, adAccountId) {
  const key = String(date ?? "").trim();
  const accountKey = String(adAccountId ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key) || !accountKey) return false;
  return db.prepare("DELETE FROM meta_ads_daily_metrics WHERE date = ? AND ad_account_id = ?").run(key, accountKey).changes > 0;
}

export function getMetaConversionEvent(eventId) {
  const id = String(eventId ?? "").trim();
  if (!id) return null;

  return db
    .prepare(
      `SELECT event_id AS eventId,
              payment_id AS paymentId,
              phone_number AS phoneNumber,
              account_id AS accountId,
              conversation_id AS conversationId,
              event_name AS eventName,
              value,
              currency,
              status,
              response_json AS responseJson,
              error,
              sent_at AS sentAt,
              created_at AS createdAt,
              updated_at AS updatedAt
       FROM meta_conversion_events
       WHERE event_id = ?`
    )
    .get(id) ?? null;
}

export function upsertMetaConversionEvent(details = {}) {
  const eventId = String(details.eventId ?? "").trim();
  if (!eventId) return false;

  const now = nowIso();
  db.prepare(
    `INSERT INTO meta_conversion_events (
       event_id, payment_id, phone_number, account_id, conversation_id, event_name,
       value, currency, status, response_json, error, sent_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(event_id) DO UPDATE SET
       payment_id = COALESCE(excluded.payment_id, payment_id),
       phone_number = excluded.phone_number,
       account_id = excluded.account_id,
       conversation_id = excluded.conversation_id,
       event_name = excluded.event_name,
       value = excluded.value,
       currency = excluded.currency,
       status = excluded.status,
       response_json = excluded.response_json,
       error = excluded.error,
       sent_at = excluded.sent_at,
       updated_at = excluded.updated_at`
  ).run(
    eventId,
    details.paymentId ?? null,
    String(details.phoneNumber ?? "").trim(),
    String(details.accountId ?? "").trim(),
    String(details.conversationId ?? "").trim(),
    String(details.eventName ?? "").trim(),
    Number(details.value) || 0,
    String(details.currency ?? "").trim(),
    String(details.status ?? "pending").trim() || "pending",
    details.responseJson ? JSON.stringify(details.responseJson) : "",
    String(details.error ?? "").trim(),
    details.sentAt ?? null,
    now,
    now
  );

  return true;
}

export function getRevenueAdjustment(date) {
  const key = String(date ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return { date: key, amount: 0, note: "", updatedAt: "" };

  const row = db
    .prepare(
      `SELECT date,
              amount,
              note,
              updated_at AS updatedAt
       FROM revenue_adjustments
       WHERE date = ?`
    )
    .get(key);

  return row ?? { date: key, amount: 0, note: "", updatedAt: "" };
}

export function listRevenueAdjustmentsRange(filters = {}) {
  const conditions = [];
  const params = [];
  const from = String(filters.from ?? "").trim();
  const to = String(filters.to ?? "").trim();

  if (/^\d{4}-\d{2}-\d{2}$/.test(from)) {
    conditions.push("date >= ?");
    params.push(from);
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    conditions.push("date <= ?");
    params.push(to);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  return db
    .prepare(
      `SELECT date,
              amount,
              note,
              updated_at AS updatedAt
       FROM revenue_adjustments
       ${where}
       ORDER BY date ASC`
    )
    .all(...params);
}

export function upsertRevenueAdjustment(date, details = {}) {
  const key = String(date ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return false;

  const amount = Number.parseInt(details.amount ?? 0, 10) || 0;
  const note = String(details.note ?? "").trim();
  const now = nowIso();

  db.prepare(
    `INSERT INTO revenue_adjustments (date, amount, note, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET
       amount = excluded.amount,
       note = excluded.note,
       updated_at = excluded.updated_at`
  ).run(key, amount, note, now);

  return true;
}

export function getSetting(key, fallback = "") {
  return db.prepare("SELECT value FROM settings WHERE key = ?").get(key)?.value ?? fallback;
}

export function getSettings() {
  const rows = db.prepare("SELECT key, value FROM settings ORDER BY key").all();
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

export function updateSettings(settings) {
  const update = db.prepare(
    `INSERT INTO settings (key, value)
     VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  );

  for (const [key, value] of Object.entries(settings)) {
    update.run(key, String(value));
  }
}

function computeReminderDate(from = new Date()) {
  return new Date(from.getTime() + 6 * 60 * 60 * 1000);
}

function computeFlashOfferDate(from = new Date()) {
  return new Date(from.getTime() + 23 * 60 * 60 * 1000);
}

export function scheduleReminder(phoneNumber, conversationId) {
  ensureContact(phoneNumber, { conversationId });

  const contact = getContact(phoneNumber);
  if (contact.paid || contact.handoff || contact.promo_sent) {
    return null;
  }

  const reminderAt = computeReminderDate().toISOString();
  const flashAt = computeFlashOfferDate().toISOString();
  db.prepare(
    `UPDATE contacts
     SET reminder_scheduled_at = ?,
          reminder2_scheduled_at = ?,
          conversation_id = COALESCE(NULLIF(?, ''), conversation_id),
          updated_at = ?
      WHERE phone_number = ?`
  ).run(reminderAt, flashAt, conversationId ?? "", nowIso(), phoneNumber);

  return reminderAt;
}

export function listDueReminders(date = new Date()) {
  const now = date.toISOString();
  return db
    .prepare(
      `SELECT *
       FROM contacts
       WHERE paid = 0
         AND handoff = 0
         AND promo_sent = 0
          AND reminder_sent_at IS NULL
           AND reminder_attempted_at IS NULL
           AND reminder_scheduled_at IS NOT NULL
           AND reminder_scheduled_at <= ?
       ORDER BY reminder_scheduled_at ASC
       LIMIT 25`
    )
    .all(now);
}

export function listDueReminder2s(date = new Date()) {
  const now = date.toISOString();
  return db
    .prepare(
      `SELECT *
       FROM contacts
       WHERE paid = 0
         AND handoff = 0
         AND promo_sent = 0
          AND reminder2_sent_at IS NULL
           AND reminder2_attempted_at IS NULL
           AND reminder2_scheduled_at IS NOT NULL
           AND reminder2_scheduled_at <= ?
       ORDER BY reminder2_scheduled_at ASC
       LIMIT 25`
    )
    .all(now);
}

export function claimDueReminder(phoneNumber, date = new Date()) {
  const now = date.toISOString();
  const result = db.prepare(
    `UPDATE contacts
     SET reminder_attempted_at = ?,
         reminder_scheduled_at = NULL,
         updated_at = ?
     WHERE phone_number = ?
       AND paid = 0
       AND handoff = 0
       AND promo_sent = 0
       AND reminder_sent_at IS NULL
       AND reminder_attempted_at IS NULL
       AND reminder_scheduled_at IS NOT NULL
       AND reminder_scheduled_at <= ?`
  ).run(now, now, phoneNumber, now);

  return result.changes === 1;
}

export function claimDueReminder2(phoneNumber, date = new Date()) {
  const now = date.toISOString();
  const result = db.prepare(
    `UPDATE contacts
     SET reminder2_attempted_at = ?,
         reminder2_scheduled_at = NULL,
         updated_at = ?
     WHERE phone_number = ?
       AND paid = 0
       AND handoff = 0
       AND promo_sent = 0
       AND reminder2_sent_at IS NULL
       AND reminder2_attempted_at IS NULL
       AND reminder2_scheduled_at IS NOT NULL
       AND reminder2_scheduled_at <= ?`
  ).run(now, now, phoneNumber, now);

  return result.changes === 1;
}

export function markReminderSent(phoneNumber) {
  ensureContact(phoneNumber);
  db.prepare(
    `UPDATE contacts
      SET reminder_sent_at = ?,
           reminder_scheduled_at = NULL,
           updated_at = ?
       WHERE phone_number = ?`
  ).run(nowIso(), nowIso(), phoneNumber);
}

export function markReminder2Sent(phoneNumber) {
  ensureContact(phoneNumber);
  db.prepare(
    `UPDATE contacts
     SET reminder2_sent_at = ?,
          reminder2_scheduled_at = NULL,
          updated_at = ?
      WHERE phone_number = ?`
  ).run(nowIso(), nowIso(), phoneNumber);
}

export function markProductReleased(phoneNumber) {
  ensureContact(phoneNumber);
  db.prepare(
    `UPDATE contacts
     SET promo_sent = 1,
          promo_sent_at = ?,
          promo_scheduled_at = NULL,
          reminder_scheduled_at = NULL,
          reminder2_scheduled_at = NULL,
          updated_at = ?
      WHERE phone_number = ?`
  ).run(nowIso(), nowIso(), phoneNumber);
}

export function clearScheduledFollowUp(phoneNumber) {
  ensureContact(phoneNumber);
  db.prepare("UPDATE contacts SET promo_scheduled_at = NULL, updated_at = ? WHERE phone_number = ?").run(
    nowIso(),
    phoneNumber
  );
}

export function clearAllScheduledFollowUps() {
  return db.prepare("UPDATE contacts SET promo_scheduled_at = NULL, updated_at = ? WHERE promo_scheduled_at IS NOT NULL").run(
    nowIso()
  ).changes;
}
