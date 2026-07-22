export const FLOW_EDITABLE_FIELDS = Object.freeze({
  master_prompt: { label: "Prompt maestro", input: "textarea", maxLength: 12000 },
  first_reply_prompt: { label: "Regla del primer mensaje", input: "textarea", maxLength: 4000 },
  next_reply_prompt: { label: "Regla de respuestas siguientes", input: "textarea", maxLength: 4000 },
  paid_reply_prompt: { label: "Regla para compradores", input: "textarea", maxLength: 4000 },
  followup_reminder_text: { label: "Recordatorio fallback (audio falla)", input: "textarea", maxLength: 4000 },
  reminder_detail_text: { label: "Texto recordatorio 6h", input: "textarea", maxLength: 4000 },
  reminder_product_description: { label: "Descripción del producto 6h", input: "textarea", maxLength: 4000 },
  reminder2_offer_text: { label: "Oferta 23h", input: "textarea", maxLength: 4000 },
  flash_offer_text: { label: "Bombazo manual", input: "textarea", maxLength: 4000 },
  product_access_url: { label: "Link de acceso", input: "url", maxLength: 2000 },
  product_delivery_text: { label: "Entrega post-pago", input: "textarea", maxLength: 4000 },
  openai_max_tokens: { label: "Máximo de tokens", input: "number", min: 60, max: 800 },
});

export const CONVERSATION_FLOW = Object.freeze({
  nodes: [
    { id: "incoming", title: "Mensaje entrante", subtitle: "WhatsApp · Instagram · Facebook", description: "Recibe el mensaje, conserva el canal y la conversación, y separa las identidades sociales por cuenta para responder por la misma vía.", type: "trigger", x: 40, y: 280 },
    { id: "routing", title: "Clasificar mensaje", subtitle: "Saludo, consulta, archivo o pago", description: "Identifica si el contacto saluda, consulta por el producto, envía un comprobante o requiere revisión humana para decidir el siguiente paso.", type: "condition", x: 310, y: 280 },
    { id: "greeting", title: "Saludo inicial", subtitle: "Audio + primera respuesta", description: "Ante un saludo inicial, envía el audio de bienvenida y pregunta si la persona quiere conocer el Kit Yoga Pro.", type: "message", x: 590, y: 40, fields: ["first_reply_prompt"], media: [
      { type: "audio", label: "Audio de saludo", src: "/media/audios/saludo.mp3" },
    ] },
    { id: "product", title: "Interés en el producto", subtitle: "Audio, imagen y respuesta IA", description: "Cuando detecta interés, comparte la imagen informativa y el audio del producto antes de responder según el contexto de la conversación.", type: "message", x: 590, y: 210, fields: ["master_prompt", "next_reply_prompt", "openai_max_tokens"], media: [
      { type: "image", label: "Imagen informativa", src: "/media/info.jpeg" },
      { type: "audio", label: "Audio con información del producto", src: "/media/audios/info-del-producto.mp3" },
    ] },
    { id: "preview", title: "Vista del material", subtitle: "Video + alias de pago", description: "Tras el visto bueno del contacto, envía un audio de introducción, el video de muestra y luego el alias de pago en mensajes separados.", type: "action", x: 890, y: 210, media: [
      { type: "audio", label: "Audio antes del video", src: "/media/audios/antes-del-video.mp3" },
      { type: "video", label: "Video de muestra del material", src: "/media/videomaterial.mp4" },
    ] },
    { id: "reminder", title: "Recordatorio 6h", subtitle: "Audio + detalle del producto", description: "A las 6 horas, si no hubo pago, promoción ni revisión humana, envía el audio de recordatorio, el texto de detalle y la descripción completa del producto.", type: "message", x: 1190, y: 40, fields: ["followup_reminder_text", "reminder_detail_text", "reminder_product_description"], media: [
      { type: "audio", label: "Audio de recordatorio 6 h", src: "/media/audios/23horas.mp3" },
    ] },
    { id: "reminder23h", title: "Oferta 23h", subtitle: "Descuento automático", description: "A las 23 horas de la última interacción, si el contacto aún no compró, envía una oferta con descuento especial de $6.999.", type: "message", x: 1490, y: 40, fields: ["reminder2_offer_text"] },
    { id: "payment", title: "Comprobante", subtitle: "Detectar y registrar pago", description: "Reconoce adjuntos de pago, extrae los datos disponibles y registra la venta antes de habilitar la entrega del producto.", type: "condition", x: 590, y: 450, media: [
      { type: "audio", label: "Audio de confirmación de comprobante", src: "/media/audios/comprobante.mp3" },
    ] },
    { id: "attribution-recovery", title: "Recuperar origen Ads", subtitle: "Compensación post-pago", description: "Si el webhook no incluyó el origen CTWA, consulta la conversación exacta en Zernio y reintenta en segundo plano. Sólo asigna la venta cuando el ID coincide exactamente con un anuncio de Ofiprof USD.", type: "action", x: 840, y: 450 },
    { id: "delivery", title: "Entregar producto", subtitle: "Confirmación + acceso", description: "Confirma el pago y envía el mensaje de entrega con el enlace de acceso configurado.", type: "message", x: 1090, y: 450, fields: ["product_delivery_text", "product_access_url"] },
    { id: "paid", title: "Soporte comprador", subtitle: "Respuesta post-compra", description: "Para contactos con pago registrado, responde con las reglas especiales de soporte para compradores.", type: "message", x: 1390, y: 450, fields: ["paid_reply_prompt"] },
    { id: "manual", title: "Acciones manuales", subtitle: "Bombazo manual $6.999", description: "Desde el administrador se puede enviar una oferta relámpago al contacto seleccionado.", type: "message", x: 890, y: 640, fields: ["flash_offer_text"] },
    { id: "handoff", title: "Revisión humana", subtitle: "Automatización pausada", description: "Detiene la automatización para que una persona continúe la conversación desde la bandeja de revisiones.", type: "terminal", x: 590, y: 640 },
  ],
  edges: [
    ["incoming", "routing"], ["routing", "greeting"], ["routing", "product"], ["product", "preview"],
    ["preview", "reminder"], ["reminder", "reminder23h"], ["routing", "payment"], ["payment", "attribution-recovery"], ["attribution-recovery", "delivery"], ["delivery", "paid"],
    ["routing", "handoff"], ["manual", "delivery"],
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
