/**
 * Minimal RFC-4180 CSV reader. Zero dependencies on purpose: the profiler must run
 * in a repo with no package.json and no install step.
 *
 * Handles: quoted fields, escaped quotes (""), embedded newlines and commas inside
 * quotes, CRLF or LF line endings, and a UTF-8 BOM.
 */

/** @param {string} text @returns {string[][]} */
export function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip BOM

  /** @type {string[][]} */
  const rows = [];
  /** @type {string[]} */
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      endField();
      i += 1;
      continue;
    }
    if (ch === '\r') {
      if (text[i + 1] === '\n') i += 1;
      endRow();
      i += 1;
      continue;
    }
    if (ch === '\n') {
      endRow();
      i += 1;
      continue;
    }

    field += ch;
    i += 1;
  }

  // A trailing newline must not produce a phantom final row.
  if (field !== '' || row.length > 0) endRow();

  return rows;
}

/** True when every cell in the row is empty or whitespace. */
export function isBlankRow(row) {
  return row.every((cell) => cell.trim() === '');
}
