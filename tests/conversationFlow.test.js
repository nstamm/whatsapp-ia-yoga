import test from "node:test";
import assert from "node:assert/strict";
import {
  buildConversationFlow,
  CONVERSATION_FLOW,
  FLOW_EDITABLE_FIELDS,
  validateFlowSettings,
} from "../src/conversationFlow.js";

test("flow definition has unique nodes and valid connections", () => {
  const nodeIds = CONVERSATION_FLOW.nodes.map((node) => node.id);
  const knownIds = new Set(nodeIds);

  assert.equal(knownIds.size, nodeIds.length);
  for (const [source, target] of CONVERSATION_FLOW.edges) {
    assert.equal(knownIds.has(source), true, `unknown source node: ${source}`);
    assert.equal(knownIds.has(target), true, `unknown target node: ${target}`);
  }
});

test("every editable flow setting is represented by exactly one node", () => {
  const representedFields = CONVERSATION_FLOW.nodes.flatMap((node) => node.fields ?? []);

  assert.deepEqual([...representedFields].sort(), Object.keys(FLOW_EDITABLE_FIELDS).sort());
  assert.equal(new Set(representedFields).size, representedFields.length);
});

test("flow keeps all core runtime stages visible", () => {
  const nodeIds = new Set(CONVERSATION_FLOW.nodes.map((node) => node.id));
  const requiredStages = [
    "incoming", "routing", "greeting", "landing", "await-video-response", "alias", "product", "downsell23h", "exclusive-offer", "final-discount",
    "payment", "attribution-recovery", "delivery", "paid", "manual", "handoff",
  ];

  for (const stage of requiredStages) assert.equal(nodeIds.has(stage), true, `missing flow stage: ${stage}`);
});

test("read-only nodes explain their runtime behavior", () => {
  const readOnlyNodes = CONVERSATION_FLOW.nodes.filter((node) => !node.fields?.length);

  for (const node of readOnlyNodes) {
    assert.equal(typeof node.description, "string", `missing description for ${node.id}`);
    assert.ok(node.description.length > 20, `description is too short for ${node.id}`);
  }
});

test("incoming flow documents account-scoped social identities", () => {
  const incoming = buildConversationFlow({}).nodes.find((node) => node.id === "incoming");
  assert.match(incoming.description, /identidades sociales por cuenta/i);
});

test("flow exposes the Fantasía greeting audio and second-response video", () => {
  const flow = buildConversationFlow();
  const greeting = flow.nodes.find((item) => item.id === "greeting");
  const alias = flow.nodes.find((item) => item.id === "alias");
  assert.deepEqual(greeting.media.map((item) => item.src), ["/media/audios/saludofantasia.mp3"]);
  assert.deepEqual(alias.media.map((item) => item.src), ["/media/contenidofantasia.mp4"]);

  const allMedia = flow.nodes.flatMap((node) => node.media ?? []);
  assert.deepEqual(allMedia.map((item) => item.src), [
    "/media/audios/saludofantasia.mp3",
    "/media/contenidofantasia.mp4",
  ]);
});

test("flow waits for one response without requiring confirmation words", () => {
  const waitNode = CONVERSATION_FLOW.nodes.find((node) => node.id === "await-video-response");
  assert.match(waitNode.description, /cualquier texto/i);
  assert.match(waitNode.description, /no exige que diga ok/i);
  assert.equal(
    CONVERSATION_FLOW.edges.some(([source, target]) => source === "landing" && target === "await-video-response"),
    true
  );
  assert.equal(
    CONVERSATION_FLOW.edges.some(([source, target]) => source === "await-video-response" && target === "alias"),
    true
  );
});

test("flow documents the direct two-stage 23h discount recovery", () => {
  const reminder = CONVERSATION_FLOW.nodes.find((node) => node.id === "downsell23h");
  const exclusive = CONVERSATION_FLOW.nodes.find((node) => node.id === "exclusive-offer");
  const finalDiscount = CONVERSATION_FLOW.nodes.find((node) => node.id === "final-discount");
  assert.match(reminder.description, /23 horas del mensaje inicial/);
  assert.match(reminder.description, /sin pedir una confirmación previa/);
  assert.match(exclusive.description, /\$9\.999/);
  assert.match(finalDiscount.description, /23 horas después del primer envío/);
  assert.match(finalDiscount.description, /aunque el contacto no haya respondido/);
  assert.match(finalDiscount.description, /\$6\.999/);
  assert.equal(CONVERSATION_FLOW.edges.some(([from, to]) => from === "downsell23h" && to === "exclusive-offer"), true);
  assert.equal(CONVERSATION_FLOW.edges.some(([from, to]) => from === "exclusive-offer" && to === "final-discount"), true);
});

test("flow documents durable greeting audio fallback", () => {
  const greeting = CONVERSATION_FLOW.nodes.find((node) => node.id === "greeting");
  assert.match(greeting.description, /lista visual de beneficios/);
  assert.match(greeting.description, /MP3 alternativo/);
  assert.match(greeting.description, /reinicie/);
});

test("flow exposes current setting values on editable nodes", () => {
  const flow = buildConversationFlow({ initial_offer_text: "Oferta desde settings" });
  const greeting = flow.nodes.find((node) => node.id === "greeting");

  assert.equal(greeting.editable, true);
  assert.equal(greeting.fields[0].value, "Oferta desde settings");
  assert.equal(flow.nodes.find((node) => node.id === "routing").editable, false);
});

test("flow settings accept known fields and normalize values", () => {
  assert.deepEqual(validateFlowSettings({ openai_max_tokens: 240, next_reply_prompt: "  Breve  " }), {
    ok: true,
    updates: { openai_max_tokens: "240", next_reply_prompt: "Breve" },
  });
});

test("flow settings reject unknown fields", () => {
  const result = validateFlowSettings({ followup_enabled: "true" });
  assert.equal(result.ok, false);
  assert.match(result.error, /no es editable/);
});

test("flow rejects an empty initial offer", () => {
  const result = validateFlowSettings({ initial_offer_text: "   " });
  assert.equal(result.ok, false);
  assert.match(result.error, /no puede quedar vacío/);
});

test("flow settings validate URL and token boundaries", () => {
  assert.equal(validateFlowSettings({ product_access_url: "http://inseguro.test" }).ok, false);
  assert.equal(validateFlowSettings({ product_landing_url: "https://fantasia.ofiprof.com" }).ok, true);
  assert.equal(validateFlowSettings({ openai_max_tokens: 59 }).ok, false);
  assert.equal(validateFlowSettings({ openai_max_tokens: 800 }).ok, true);
});
