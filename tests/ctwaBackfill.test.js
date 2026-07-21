import test from "node:test";
import assert from "node:assert/strict";
import { consumeInboxConversationPages, shouldProcessCtwaBackfillConversation, shouldRunCtwaBackfill } from "../src/ctwaBackfill.js";

test("skips backfill by default", () => {
  assert.equal(shouldRunCtwaBackfill({ env: {} }), false);
});

test("enables backfill when the explicit query flag is provided", () => {
  assert.equal(shouldRunCtwaBackfill({ query: { ctwaBackfill: "1" }, env: {} }), true);
  assert.equal(shouldRunCtwaBackfill({ query: { ctwaBackfill: "true" }, env: {} }), true);
});

test("enables backfill when the environment flag is set", () => {
  assert.equal(shouldRunCtwaBackfill({ env: { CTWA_BACKFILL_ENABLED: "true" } }), true);
  assert.equal(shouldRunCtwaBackfill({ env: { CTWA_BACKFILL_ENABLED: "1" } }), true);
});

test("targeted recovery only processes the exact Zernio conversation", () => {
  assert.equal(shouldProcessCtwaBackfillConversation({ id: "conversation-a" }, { conversationIds: ["conversation-a"] }), true);
  assert.equal(shouldProcessCtwaBackfillConversation({ id: "conversation-b" }, { conversationIds: ["conversation-a"] }), false);
  assert.equal(shouldProcessCtwaBackfillConversation({ id: "conversation-b" }), true);
});

test("consumes every cursor page until Zernio reports no more conversations", async () => {
  const calls = [];
  const seen = [];
  const result = await consumeInboxConversationPages(async ({ limit, cursor }) => {
    calls.push({ limit, cursor });
    if (!cursor) return { data: [{ id: "first" }, { id: "second" }], pagination: { hasMore: true, nextCursor: "cursor-1" } };
    return { data: [{ id: "third" }], pagination: { hasMore: false, nextCursor: null } };
  }, {
    maxPages: 10,
    onPage: (rows) => seen.push(...rows.map((row) => row.id)),
  });

  assert.deepEqual(calls, [{ limit: 100, cursor: "" }, { limit: 100, cursor: "cursor-1" }]);
  assert.deepEqual(seen, ["first", "second", "third"]);
  assert.deepEqual(result, { pages: 2, conversations: 3, hasMore: false, truncated: false });
});

test("stops after the configured page limit without following more cursors", async () => {
  const result = await consumeInboxConversationPages(async () => ({
    data: [{ id: "first" }],
    pagination: { hasMore: true, nextCursor: "cursor-1" },
  }), { maxPages: 1 });

  assert.deepEqual(result, { pages: 1, conversations: 1, hasMore: true, truncated: true });
});

test("rejects a repeated Zernio cursor instead of looping forever", async () => {
  await assert.rejects(
    consumeInboxConversationPages(async ({ cursor }) => ({
      data: [],
      pagination: { hasMore: true, nextCursor: cursor || "cursor-1" },
    }), { maxPages: 10 }),
    /repeated inbox pagination cursor/
  );
});
