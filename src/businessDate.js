export const BUSINESS_TIME_ZONE = "America/Argentina/Buenos_Aires";

const formatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: BUSINESS_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function dateKeyFromParts(parts) {
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function isBusinessDateKey(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ""))) return false;
  const [year, month, day] = String(value).split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function businessDateKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return businessDateKey();
  return dateKeyFromParts(formatter.formatToParts(date));
}

export function shiftBusinessDateKey(dateKey, days) {
  const key = isBusinessDateKey(dateKey) ? dateKey : businessDateKey();
  const [year, month, day] = key.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + Number(days || 0))).toISOString().slice(0, 10);
}

function timezoneOffsetAt(date) {
  const values = Object.fromEntries(formatter.formatToParts(date).map(({ type, value }) => [type, value]));
  const localAsUtc = Date.UTC(values.year, Number(values.month) - 1, values.day, values.hour || 0, values.minute || 0, values.second || 0);
  return localAsUtc - date.getTime();
}

export function businessDateStart(dateKey) {
  const key = isBusinessDateKey(dateKey) ? dateKey : businessDateKey();
  const [year, month, day] = key.split("-").map(Number);
  const localMidnightAsUtc = Date.UTC(year, month - 1, day);
  let instant = new Date(localMidnightAsUtc);

  // Resolve local midnight against the IANA zone instead of the server zone.
  for (let index = 0; index < 2; index += 1) {
    instant = new Date(localMidnightAsUtc - timezoneOffsetAt(instant));
  }

  return instant;
}

export function businessDateRange(dateKey) {
  const key = isBusinessDateKey(dateKey) ? dateKey : businessDateKey();
  const start = businessDateStart(key);
  const end = new Date(businessDateStart(shiftBusinessDateKey(key, 1)).getTime() - 1);
  return { start, end };
}

export function parseBusinessDateKey(value, fallback = new Date()) {
  return businessDateStart(isBusinessDateKey(value) ? String(value) : businessDateKey(fallback));
}
