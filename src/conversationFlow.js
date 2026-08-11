export const FLOW_EDITABLE_FIELDS = Object.freeze({
  master_prompt: { label: "Prompt maestro", input: "textarea", maxLength: 12000 },
  next_reply_prompt: { label: "Regla de respuestas siguientes", input: "textarea", maxLength: 4000 },
  paid_reply_prompt: { label: "Regla para compradores", input: "textarea", maxLength: 4000 },
  initial_offer_text: { label: "Información inicial", input: "textarea", maxLength: 4000, required: true },
  product_landing_text: { label: "Mensaje de la landing", input: "textarea", maxLength: 4000, required: true },
  product_landing_url: { label: "URL de la landing", input: "url", maxLength: 2000, required: true },
  payment_alias: { label: "Alias de pago", input: "text", maxLength: 200, required: true },
  payment_alias_note: { label: "Aclaración del alias", input: "text", maxLength: 500, required: true },
  reminder2_offer_text: { label: "Recordatorio 23h", input: "textarea", maxLength: 4000 },
  flash_offer_text: { label: "Oferta manual", input: "textarea", maxLength: 4000 },
  product_access_url: { label: "Link de acceso", input: "url", maxLength: 2000 },
  product_delivery_text: { label: "Entrega post-pago", input: "textarea", maxLength: 4000 },
  openai_max_tokens: { label: "Máximo de tokens", input: "number", min: 60, max: 800 },
});

export const CONVERSATION_FLOW = Object.freeze({
  nodes: [
    { id: "incoming", title: "Mensaje entrante", subtitle: "WhatsApp · Instagram · Facebook", description: "Recibe el mensaje, conserva el canal y la conversación, y separa las identidades sociales por cuenta para responder por la misma vía.", type: "trigger", x: 40, y: 280 },
    { id: "routing", title: "Clasificar mensaje", subtitle: "Saludo, consulta, archivo o pago", description: "Identifica si el contacto saluda, consulta por el producto, envía un comprobante o requiere revisión humana para decidir el siguiente paso.", type: "condition", x: 310, y: 280 },
    { id: "greeting", title: "Saludo e información", subtitle: "Audio + Fantasía Color PRO", description: "Ante el primer mensaje, envía el audio de bienvenida y presenta Fantasía Color PRO con el precio exclusivo por WhatsApp de $16.999. Si el proveedor rechaza el audio, usa el MP3 alternativo y conserva el reintento aunque el proceso se reinicie.", type: "message", x: 590, y: 40, fields: ["initial_offer_text"], media: [
      { type: "audio", label: "Audio de saludo Fantasía", src: "/media/audios/saludofantasia.mp3" },
    ] },
    { id: "landing", title: "Landing con muestras", subtitle: "Preview Open Graph", description: "Después de la información envía la landing en un mensaje separado para que WhatsApp genere la tarjeta con título, descripción e imagen.", type: "message", x: 890, y: 40, fields: ["product_landing_text", "product_landing_url"] },
    { id: "alias", title: "Primera respuesta", subtitle: "Video + alias + aclaración", description: "Cuando el contacto responde por primera vez después de recibir la información, envía el video del contenido, el alias en un mensaje separado y luego aclara a nombre de quién está.", type: "message", x: 1190, y: 40, fields: ["payment_alias", "payment_alias_note"], media: [
      { type: "video", label: "Video de Fantasía Color PRO", src: "/media/contenidofantasia.mp4" },
    ] },
    { id: "product", title: "Dudas sobre el producto", subtitle: "Respuesta IA contextual", description: "Responde preguntas sobre imprimibles, uso y contenido. Ante cualquier consulta por una serie, personaje o temática, confirma que sí está incluida.", type: "message", x: 890, y: 230, fields: ["master_prompt", "next_reply_prompt", "openai_max_tokens"] },
    { id: "downsell23h", title: "Recordatorio 23h", subtitle: "Oferta WhatsApp $16.999", description: "A las 23 horas de la información inicial, si el contacto aún no compró, recuerda una sola vez la oferta exclusiva por WhatsApp de $16.999.", type: "message", x: 1490, y: 40, fields: ["reminder2_offer_text"] },
    { id: "payment", title: "Comprobante", subtitle: "Detectar y registrar pago", description: "Reconoce adjuntos de pago, extrae los datos disponibles y registra la venta antes de habilitar la entrega del producto.", type: "condition", x: 590, y: 450 },
    { id: "attribution-recovery", title: "Recuperar origen Ads", subtitle: "Compensación post-pago", description: "Si el webhook no incluyó el origen CTWA, consulta la conversación exacta en Zernio y reintenta en segundo plano. Sólo asigna la venta cuando el ID coincide exactamente con un anuncio de Ofiprof USD.", type: "action", x: 840, y: 450 },
    { id: "delivery", title: "Entregar producto", subtitle: "Confirmación + acceso", description: "Confirma el pago y envía el mensaje de entrega con el enlace de acceso configurado.", type: "message", x: 1090, y: 450, fields: ["product_delivery_text", "product_access_url"] },
    { id: "paid", title: "Soporte comprador", subtitle: "Respuesta post-compra", description: "Para contactos con pago registrado, responde con las reglas especiales de soporte para compradores.", type: "message", x: 1390, y: 450, fields: ["paid_reply_prompt"] },
    { id: "manual", title: "Acciones manuales", subtitle: "Oferta Fantasía $16.999", description: "Desde el administrador se puede enviar manualmente la oferta de Fantasía Color PRO al contacto seleccionado.", type: "message", x: 890, y: 640, fields: ["flash_offer_text"] },
    { id: "handoff", title: "Revisión humana", subtitle: "Automatización pausada", description: "Detiene la automatización para que una persona continúe la conversación desde la bandeja de revisiones.", type: "terminal", x: 590, y: 640 },
  ],
  edges: [
    ["incoming", "routing"], ["routing", "greeting"], ["routing", "product"], ["greeting", "landing"], ["landing", "alias"], ["alias", "product"],
    ["greeting", "downsell23h"], ["routing", "payment"], ["payment", "attribution-recovery"], ["attribution-recovery", "delivery"], ["delivery", "paid"],
    ["routing", "handoff"], ["manual", "payment"],
  ],
});

export function buildConversationFlow(settings = {}) {
  return {
    nodes: CONVERSATION_FLOW.nodes.map((node) => ({
      ...node,
      editable: Boolean(node.fields?.length),
      fields: (node.fields ?? []).map((key) => ({
        key,
        ...FLOW_EDITABLE_FIELDS[key],
        value: String(settings[key] ?? ""),
      })),
    })),
    edges: CONVERSATION_FLOW.edges.map(([source, target]) => ({ source, target })),
  };
}

export function validateFlowSettings(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "El cuerpo debe contener un objeto de configuración." };
  }

  const updates = {};
  for (const [key, rawValue] of Object.entries(input)) {
    const field = FLOW_EDITABLE_FIELDS[key];
    if (!field) return { ok: false, error: `El campo ${key} no es editable desde el flujo.` };

    const value = String(rawValue ?? "").trim();
    if (field.required && !value) return { ok: false, error: `${field.label} no puede quedar vacío.` };
    if (value.length > field.maxLength) return { ok: false, error: `${field.label} supera el máximo permitido.` };
    if (field.input === "url" && value && !/^https:\/\//i.test(value)) {
      return { ok: false, error: `${field.label} debe ser una URL HTTPS.` };
    }
    if (field.input === "number") {
      const number = Number(value);
      if (!Number.isInteger(number) || number < field.min || number > field.max) {
        return { ok: false, error: `${field.label} debe estar entre ${field.min} y ${field.max}.` };
      }
    }
    updates[key] = value;
  }

  if (!Object.keys(updates).length) return { ok: false, error: "No hay cambios para guardar." };
  return { ok: true, updates };
}
