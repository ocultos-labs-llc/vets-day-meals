/** RFC 4180-style CSV parser. Handles quotes, escaped quotes, and newlines inside fields. */
export function parseCsv(text) {
  let src = String(text || "");
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);
  src = src.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  const table = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < src.length; i += 1) {
    const char = src[i];
    if (quoted) {
      if (char === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === ",") {
      row.push(field);
      field = "";
      continue;
    }
    if (char === "\n") {
      row.push(field);
      field = "";
      table.push(row);
      row = [];
      continue;
    }
    field += char;
  }
  if (field.length || row.length) {
    row.push(field);
    table.push(row);
  }

  while (table.length && table[table.length - 1].every((cell) => cell === "")) table.pop();
  if (!table.length) return [];

  const headers = table[0].map((header) => header.trim());
  const records = [];
  for (let r = 1; r < table.length; r += 1) {
    const cells = table[r];
    if (!cells.some((cell) => String(cell).trim() !== "")) continue;
    const record = {};
    for (let c = 0; c < headers.length; c += 1) {
      const header = headers[c];
      if (!header) continue;
      record[header] = String(cells[c] ?? "").trim();
    }
    records.push(record);
  }
  return records;
}
