function parseBoolean(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off", ""].includes(normalized)) return false;
  }
  return false;
}

export function shouldRunCtwaBackfill(options = {}) {
  const query = options.query ?? {};
  const env = options.env ?? process.env;
  const explicitFlag = parseBoolean(query.ctwaBackfill ?? query.ctwa_backfill);
  if (explicitFlag) return true;
  return parseBoolean(env.CTWA_BACKFILL_ENABLED);
}

export async function consumeInboxConversationPages(fetchPage, options = {}) {
  const limit = Math.min(100, Math.max(1, Number(options.limit) || 100));
  const maxPages = Math.max(1, Number(options.maxPages) || 1);
  const onPage = options.onPage ?? (() => {});
  const seenCursors = new Set();
  let cursor = "";
  let pages = 0;
  let conversations = 0;
  let hasMore = false;

  while (pages < maxPages) {
    if (cursor && seenCursors.has(cursor)) throw new Error("Zernio returned a repeated inbox pagination cursor");
    if (cursor) seenCursors.add(cursor);

    const payload = await fetchPage({ limit, cursor });
    const rows = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.conversations) ? payload.conversations : [];
    pages += 1;
    conversations += rows.length;
    await onPage(rows, payload);

    const nextCursor = String(payload?.pagination?.nextCursor ?? payload?.nextCursor ?? "").trim();
    hasMore = Boolean(payload?.pagination?.hasMore ?? payload?.hasMore) && Boolean(nextCursor);
    if (!hasMore) break;
    cursor = nextCursor;
  }

  return { pages, conversations, hasMore, truncated: hasMore && pages >= maxPages };
}
