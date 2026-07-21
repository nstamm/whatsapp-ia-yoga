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
    "incoming", "routing", "greeting", "product", "preview", "reminder",
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

test("flow exposes previewable media for every audio and video step", () => {
  const flow = buildConversationFlow();
  const expectedMedia = {
    greeting: ["/media/audios/saludo.mp3"],
    product: ["/media/info.jpeg", "/media/audios/info-del-producto.mp3"],
    preview: ["/media/audios/antes-del-video.mp3", "/media/videomaterial.mp4"],
    reminder: ["/media/audios/23horas.mp3"],
    payment: ["/media/audios/comprobante.mp3"],
  };

  for (const [nodeId, sources] of Object.entries(expectedMedia)) {
    const node = flow.nodes.find((item) => item.id === nodeId);
    assert.deepEqual(node.media.map((item) => item.src), sources);
    assert.ok(node.media.every((item) => ["audio", "video", "image"].includes(item.type)));
  }
});

test("flow exposes current setting values on editable nodes", () => {
  const flow = buildConversationFlow({ first_reply_prompt: "Hola desde settings" });
  const greeting = flow.nodes.find((node) => node.id === "greeting");

  assert.equal(greeting.editable, true);
  assert.equal(greeting.fields[0].value, "Hola desde settings");
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

test("flow settings validate URL and token boundaries", () => {
  assert.equal(validateFlowSettings({ product_access_url: "http://inseguro.test" }).ok, false);
  assert.equal(validateFlowSettings({ openai_max_tokens: 59 }).ok, false);
  assert.equal(validateFlowSettings({ openai_max_tokens: 800 }).ok, true);
});
