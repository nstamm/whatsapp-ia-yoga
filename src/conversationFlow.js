export const FLOW_EDITABLE_FIELDS = Object.freeze({
  master_prompt: { label: "Prompt maestro", input: "textarea", maxLength: 12000 },
  next_reply_prompt: { label: "Regla de respuestas siguientes", input: "textarea", maxLength: 4000 },
  paid_reply_prompt: { label: "Regla para compradores", input: "textarea", maxLength: 4000 },
  initial_offer_text: { label: "Oferta inicial + confirmación de video", input: "textarea", maxLength: 4000, required: true },
  reminder2_offer_text: { label: "Downsell 23h", input: "textarea", maxLength: 4000 },
  flash_offer_text: { label: "Bombazo manual", input: "textarea", maxLength: 4000 },
  product_access_url: { label: "Link de acceso", input: "url", maxLength: 2000 },
  product_delivery_text: { label: "Entrega post-pago", input: "textarea", maxLength: 4000 },
  openai_max_tokens: { label: "Máximo de tokens", input: "number", min: 60, max: 800 },
});

export const CONVERSATION_FLOW = Object.freeze({
  nodes: [
    { id: "incoming", title: "Mensaje entrante", subtitle: "WhatsApp · Instagram · Facebook", description: "Recibe el mensaje, conserva el canal y la conversación, y separa las identidades sociales por cuenta para responder por la misma vía.", type: "trigger", x: 40, y: 280 },
    { id: "routing", title: "Clasificar mensaje", subtitle: "Saludo, consulta, archivo o pago", description: "Identifica si el contacto saluda, consulta por el producto, envía un comprobante o requiere revisión humana para decidir el siguiente paso.", type: "condition", x: 310, y: 280 },
    { id: "greeting", title: "Saludo y oferta", subtitle: "Único audio + oferta completa", description: "Ante el primer mensaje, envía una sola vez el audio de bienvenida y luego la oferta completa para práctica en casa o uso profesional. Termina preguntando si la persona quiere ver el video.", type: "message", x: 590, y: 40, fields: ["initial_offer_text"], media: [
      { type: "audio", label: "Audio de saludo", src: "/media/audios/saludo.mp3" },
    ] },
    { id: "product", title: "Dudas sobre el producto", subtitle: "Respuesta IA contextual", description: "Responde preguntas sin repetir la oferta y adapta los beneficios a práctica en casa o uso profesional.", type: "message", x: 590, y: 210, fields: ["master_prompt", "next_reply_prompt", "openai_max_tokens"] },
    { id: "preview", title: "Confirmación y video", subtitle: "Video + alias de pago", description: "Al segundo mensaje del contacto, envía el video de muestra y luego el alias de pago en mensajes separados, sin importar la respuesta.", type: "action", x: 890, y: 40, media: [
      { type: "video", label: "Video de muestra del material", src: "/media/videomaterial.mp4" },
    ] },
    { id: "downsell23h", title: "Downsell 23h", subtitle: "Oferta automática $6.999", description: "A las 23 horas de la oferta inicial, si el contacto aún no compró, envía una sola vez el precio especial de $6.999.", type: "message", x: 1190, y: 40, fields: ["reminder2_offer_text"] },
    { id: "payment", title: "Comprobante", subtitle: "Detectar y registrar pago", description: "Reconoce adjuntos de pago, extrae los datos disponibles y registra la venta antes de habilitar la entrega del producto.", type: "condition", x: 590, y: 450 },
    { id: "attribution-recovery", title: "Recuperar origen Ads", subtitle: "Compensación post-pago", description: "Si el webhook no incluyó el origen CTWA, consulta la conversación exacta en Zernio y reintenta en segundo plano. Sólo asigna la venta cuando el ID coincide exactamente con un anuncio de Ofiprof USD.", type: "action", x: 840, y: 450 },
    { id: "delivery", title: "Entregar producto", subtitle: "Confirmación + acceso", description: "Confirma el pago y envía el mensaje de entrega con el enlace de acceso configurado.", type: "message", x: 1090, y: 450, fields: ["product_delivery_text", "product_access_url"] },
    { id: "paid", title: "Soporte comprador", subtitle: "Respuesta post-compra", description: "Para contactos con pago registrado, responde con las reglas especiales de soporte para compradores.", type: "message", x: 1390, y: 450, fields: ["paid_reply_prompt"] },
    { id: "manual", title: "Acciones manuales", subtitle: "Bombazo manual $6.999", description: "Desde el administrador se puede enviar una oferta relámpago al contacto seleccionado.", type: "message", x: 890, y: 640, fields: ["flash_offer_text"] },
    { id: "handoff", title: "Revisión humana", subtitle: "Automatización pausada", description: "Detiene la automatización para que una persona continúe la conversación desde la bandeja de revisiones.", type: "terminal", x: 590, y: 640 },
  ],
  edges: [
    ["incoming", "routing"], ["routing", "greeting"], ["routing", "product"], ["greeting", "preview"],
    ["greeting", "downsell23h"], ["routing", "payment"], ["payment", "attribution-recovery"], ["attribution-recovery", "delivery"], ["delivery", "paid"],
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
