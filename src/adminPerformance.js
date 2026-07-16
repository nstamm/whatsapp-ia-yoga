export function isFreshTimestamp(updatedAt, ttlMs, now = Date.now()) {
  const timestamp = Date.parse(String(updatedAt ?? ""));
  return Number.isFinite(timestamp) && now - timestamp >= 0 && now - timestamp < ttlMs;
}

export function isValidDateKey(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ""));
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function adminSectionDataNeeds(section) {
  return {
    dashboard: section === "dashboard",
    ads: section === "ads",
    conversations: section === "conversations",
    income: section === "income",
    flow: section === "flow",
    settings: section === "settings",
    financial: ["dashboard", "ads", "income", "settings"].includes(section),
  };
}

export function buildAdminConversationQuery(query = {}, todayKey) {
  const quickFilter = String(query.quickFilter ?? "all");
  const shift = (days) => {
    const date = new Date(`${todayKey}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  };
  const activityDate = quickFilter === "today"
    ? todayKey
    : quickFilter === "yesterday"
      ? shift(-1)
      : quickFilter === "before-yesterday" ? shift(-2) : "";
  return {
    filter: String(query.convFilter ?? "all"),
    quickFilter,
    search: String(query.q ?? "").trim(),
    activityFrom: activityDate,
    activityTo: activityDate,
  };
}

export function createAsyncTtlCache({ ttlMs, maxEntries = 20, now = Date.now } = {}) {
  const values = new Map();
  const pending = new Map();
  const generations = new Map();

  return {
    peek(key) {
      const entry = values.get(key);
      if (!entry) return undefined;
      if (now() >= entry.expiresAt) {
        values.delete(key);
        if (!pending.has(key)) generations.delete(key);
        return undefined;
      }
      return entry.value;
    },

    stats() {
      return { values: values.size, pending: pending.size, generations: generations.size };
    },

    async getOrLoad(key, loader, options = {}) {
      if (!options.force) {
        const cached = this.peek(key);
        if (cached !== undefined) return cached;
        if (pending.has(key)) return pending.get(key);
      }

      const generation = (generations.get(key) ?? 0) + 1;
      generations.set(key, generation);
      let request;
      request = Promise.resolve()
        .then(loader)
        .then((value) => {
          const shouldCache = options.shouldCache?.(value) ?? true;
          if (generations.get(key) === generation && shouldCache) {
            values.delete(key);
            values.set(key, { value, expiresAt: now() + ttlMs });
            while (values.size > maxEntries) {
              const evictedKey = values.keys().next().value;
              values.delete(evictedKey);
              if (!pending.has(evictedKey)) generations.delete(evictedKey);
            }
          }
          return value;
        })
        .finally(() => {
          if (pending.get(key) === request) {
            pending.delete(key);
            if (generations.get(key) === generation && !values.has(key)) generations.delete(key);
          }
        });

      pending.set(key, request);
      return request;
    },
  };
}

export async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index], index);
    }
  }

  const workerCount = Math.min(items.length, Math.max(1, Number(limit) || 1));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
