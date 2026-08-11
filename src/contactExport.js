function csvCell(value) {
  const text = String(value ?? "").replace(/[\u0000-\u001F\u007F]/g, " ");
  const safe = /^[=+\-@]/.test(text.trimStart()) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

export function contactHistoryCsv(rows = []) {
  const lines = [
    "nombre,telefono",
    ...rows.map((row) => `${csvCell(row.name)},${csvCell(row.phoneNumber)}`),
  ];
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}
