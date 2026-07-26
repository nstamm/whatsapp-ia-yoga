export const INSTAGRAM_MESSAGE_LIMIT = 1000;

export function splitMessageText(text, maxLength) {
  const value = String(text ?? "").trim();
  if (!value) return [];
  if (!Number.isInteger(maxLength) || maxLength <= 0) return [value];

  const chunks = [];
  let remaining = Array.from(value);

  while (remaining.length > maxLength) {
    const minimumBreak = Math.floor(maxLength * 0.5);
    let breakAt = -1;

    for (let index = maxLength - 1; index >= minimumBreak; index -= 1) {
      if (remaining[index] === "\n") {
        breakAt = index + 1;
        break;
      }
    }

    if (breakAt < 0) {
      for (let index = maxLength - 1; index >= minimumBreak; index -= 1) {
        if (/\s/u.test(remaining[index])) {
          breakAt = index + 1;
          break;
        }
      }
    }

    if (breakAt < 0) breakAt = maxLength;
    chunks.push(remaining.slice(0, breakAt).join("").trim());
    remaining = remaining.slice(breakAt);
    while (remaining.length && /\s/u.test(remaining[0])) remaining.shift();
  }

  if (remaining.length) chunks.push(remaining.join("").trim());
  return chunks.filter(Boolean);
}

export function reminderTextChunks(text, channel) {
  if (channel === "instagram") {
    return splitMessageText(text, INSTAGRAM_MESSAGE_LIMIT);
  }

  const value = String(text ?? "").trim();
  return value ? [value] : [];
}

export function isPermanentReminderSendError(err) {
  const message = String(err?.message ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  return (
    message.includes("outside of allowed window") ||
    message.includes("fuera del periodo permitido") ||
    message.includes("fuera de la ventana")
  );
}
