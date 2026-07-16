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
