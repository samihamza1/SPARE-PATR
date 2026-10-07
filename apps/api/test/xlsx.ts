import { strToU8, zipSync } from 'fflate';

/** A cell for {@link buildXlsx}: text, or a number written exactly as given (e.g. a float artefact). */
export type XlsxCell = string | { n: string } | null;

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A zero-based column index as letters (0 -> "A", 26 -> "AA"). */
export function columnName(i: number): string {
  let n = i + 1;
  let out = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function sheetData(rows: readonly (readonly XlsxCell[])[]): string {
  return rows
    .map((row, r) => {
      const cells = row
        .map((cell, c) => {
          const ref = `${columnName(c)}${String(r + 1)}`;
          if (cell === null) return '';
          if (typeof cell === 'string') {
            return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(cell)}</t></is></c>`;
          }
          return `<c r="${ref}"><v>${cell.n}</v></c>`;
        })
        .join('');
      return `<row r="${String(r + 1)}">${cells}</row>`;
    })
    .join('');
}

/** A worksheet with the given `<sheetData>` content, for crafted sheets. */
export function worksheet(data: string, attributes = ''): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"${attributes}><sheetData>${data}</sheetData></worksheet>`;
}

/** Builds a minimal .xlsx in memory, so tests never need a real customer file. */
export function buildXlsx(sheets: Record<string, readonly (readonly XlsxCell[])[]>): Buffer {
  return buildXlsxFromXml(
    Object.fromEntries(
      Object.entries(sheets).map(([name, rows]) => [name, worksheet(sheetData(rows))]),
    ),
  );
}

/** Builds an .xlsx from worksheet XML (see {@link worksheet}), plus any extra entries. */
export function buildXlsxFromXml(
  sheets: Record<string, string>,
  extra: Record<string, Uint8Array> = {},
): Buffer {
  const names = Object.keys(sheets);
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${names
        .map(
          (_, i) =>
            `<Override PartName="/xl/worksheets/sheet${String(i + 1)}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
        )
        .join('')}</Types>`,
    ),
    '_rels/.rels': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ),
    'xl/workbook.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names
        .map(
          (n, i) =>
            `<sheet name="${esc(n)}" sheetId="${String(i + 1)}" r:id="rId${String(i + 1)}"/>`,
        )
        .join('')}</sheets></workbook>`,
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${names
        .map(
          (_, i) =>
            `<Relationship Id="rId${String(i + 1)}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${String(i + 1)}.xml"/>`,
        )
        .join('')}</Relationships>`,
    ),
  };
  names.forEach((name, i) => {
    files[`xl/worksheets/sheet${String(i + 1)}.xml`] = strToU8(sheets[name] ?? '');
  });
  Object.assign(files, extra);
  // Fixed timestamps: the same sheets always give the same bytes (and the same sha256).
  return Buffer.from(zipSync(files, { mtime: new Date('2026-01-01T00:00:00Z') }));
}

/**
 * Rewrites one entry's headers as a hostile zip would: the uncompressed size in the
 * central directory and/or the local header, or a data-descriptor flag (local sizes 0).
 */
export function patchZipEntry(
  zip: Buffer,
  name: string,
  patch: { centralSize?: number; localSize?: number; dataDescriptor?: boolean },
): Buffer {
  const out = Buffer.from(zip);
  let end = out.length - 22;
  while (out.readUInt32LE(end) !== 0x06054b50) end--;
  let at = out.readUInt32LE(end + 16);
  for (let i = 0; i < out.readUInt16LE(end + 10); i++) {
    const nameLength = out.readUInt16LE(at + 28);
    if (out.subarray(at + 46, at + 46 + nameLength).toString('utf8') === name) {
      const local = out.readUInt32LE(at + 42);
      if (patch.centralSize !== undefined) out.writeUInt32LE(patch.centralSize, at + 24);
      if (patch.localSize !== undefined) out.writeUInt32LE(patch.localSize, local + 22);
      if (patch.dataDescriptor === true) {
        out.writeUInt16LE(out.readUInt16LE(at + 8) | 0x0008, at + 8);
        out.writeUInt16LE(out.readUInt16LE(local + 6) | 0x0008, local + 6);
        out.fill(0, local + 14, local + 26);
      }
      return out;
    }
    at += 46 + nameLength + out.readUInt16LE(at + 30) + out.readUInt16LE(at + 32);
  }
  throw new Error(`no entry ${name}`);
}
