/**
 * One pass over a worksheet's XML, before read-excel-file builds the sheet.
 *
 * The library adds an empty row for every missing row number and pads every kept row to
 * the last column holding a value, so a sheet with one value at A1 and one at XFD1048576
 * would become 17 billion cells. This scan works out, without building anything, an upper
 * bound of what the library builds. It is a port of the code that decides it: the library's
 * XML tokenizer (saxen) and attribute reader, its attribute clean-up (prefixes, entities),
 * its cell address arithmetic and the row bookkeeping of its sheet parser. Cell values are
 * not parsed: a cell with a `<v>` or an inline string counts as holding a value.
 *
 * The library feeds the XML to the tokenizer in chunks whose size depends on timing, and a
 * quoted attribute value cut by a chunk boundary can end a tag at a '>' inside the quotes.
 * XML where that could change what is read (a '<' inside any quoted value, a '>' inside a
 * quoted value of a `<row>` or `<c>`), or with more than one `<sheetData>`, is never written
 * by spreadsheet programs; it is reported as `ambiguous` and treated as past the limits.
 */
export interface SheetBounds {
  /** Rows the library holds while reading, gaps included. */
  rows: number;
  /** Rows it keeps at the end (each padded to `dataColumns`). */
  keptRows: number;
  /** Last row and last column holding a value. */
  dataRows: number;
  dataColumns: number;
  ambiguous: boolean;
}

const EMPTY: SheetBounds = { rows: 0, keptRows: 0, dataRows: 0, dataColumns: 0, ambiguous: false };

const isSpace = (w: number) => w === 32 || (w < 14 && w > 8);

/** The library's prefix removal (up to the first ':'; an `xmlns:` attribute keeps its name). */
function trimXmlnsPrefix(name: string, isAttributeName = false): string {
  for (let i = 0; i < name.length; i++) {
    if (name[i] !== ':') continue;
    if (isAttributeName && i === 5 && name.startsWith('xmlns')) continue;
    return name.slice(i + 1);
  }
  return name;
}

const ENTITY_PATTERN = /&#(\d+);|&#x([0-9a-f]+);|&(\w+);/gi;
// Lower and upper case only, as the tokenizer maps them ("&Amp;" stays as written).
const ENTITY_MAPPING: Record<string, string> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  quot: '"',
  AMP: '&',
  APOS: "'",
  GT: '>',
  LT: '<',
  QUOT: '"',
};

function decodeEntities(s: string): string {
  if (s.length <= 3 || !s.includes('&')) return s;
  return s.replace(ENTITY_PATTERN, (_, d?: string, x?: string, z?: string) => {
    if (z) return Object.hasOwn(ENTITY_MAPPING, z) ? (ENTITY_MAPPING[z] ?? '') : `&${z};`;
    if (d) return String.fromCharCode(Number(d));
    return String.fromCharCode(parseInt(x ?? '', 16));
  });
}

/**
 * The tokenizer's attribute reader (namespaces off, as the library runs it), then the
 * library's clean-up: each name loses its prefix and each value has its entities decoded.
 * The clean-up writes into the object it iterates, as the library does, so a prefixed
 * attribute followed by its plain twin is decoded twice there too.
 */
function attributesOf(s: string, start: number): Record<string, string> {
  const attrs: Record<string, string> = {};
  const seen = new Set<string>();
  let value = '';
  parseAttr: for (let i = start, l = s.length; i < l; i++) {
    let skip = false;
    let w = s.charCodeAt(i);
    if (isSpace(w)) continue;
    if ((w < 65 || w > 122 || (w > 90 && w < 97)) && w !== 95 && w !== 58) skip = true;
    let j: number;
    for (j = i + 1; j < l; j++) {
      w = s.charCodeAt(j);
      if (
        (w > 96 && w < 123) ||
        (w > 64 && w < 91) ||
        (w > 47 && w < 59) ||
        w === 46 ||
        w === 45 ||
        w === 95
      ) {
        continue;
      }
      if (isSpace(w)) {
        i = j;
        continue parseAttr;
      }
      if (w === 61) break;
      skip = true;
    }
    const name = s.substring(i, j);
    if (name === 'xmlns:xmlns') skip = true;
    w = s.charCodeAt(j + 1);
    if (w === 34 || w === 39) {
      i = j + 2;
      j = s.indexOf(w === 34 ? '"' : "'", i);
      if (j === -1) {
        j = s.indexOf(w === 34 ? "'" : '"', i);
        if (j !== -1) skip = true;
      }
    } else {
      skip = true;
      for (j = j + 1; j < l; j++) if (isSpace(s.charCodeAt(j + 1))) break;
    }
    if (j === -1) {
      j = l;
      skip = true;
    }
    if (!skip) value = s.substring(i, j);
    i = j;
    for (; j + 1 < l; j++) {
      if (isSpace(s.charCodeAt(j + 1))) break;
      if (i === j) skip = true;
    }
    i = j + 1;
    if (skip || seen.has(name)) continue;
    seen.add(name);
    attrs[name] = value;
  }
  for (const name in attrs) attrs[trimXmlnsPrefix(name, true)] = decodeEntities(attrs[name] ?? '');
  return attrs;
}

/** The library's cell address arithmetic ("AA2091" -> [2091, 27]); null where it throws. */
export function cellAddress(ref: string): [number, number] | null {
  let column = 0;
  for (let k = 0; k < ref.length; k++) {
    const code = ref.charCodeAt(k);
    if (code >= 48 && code <= 57) {
      const row = Number(ref.slice(k));
      return Number.isNaN(row) ? null : [row, column];
    }
    column = column * 26 + (code - 64);
  }
  return null;
}

/** The library's sheet parser, keeping counts instead of rows. */
class SheetCounter {
  inSheetData = false;
  sheetDataSeen = false;
  rowOpen = false;
  rowNumber: number | undefined = undefined;
  rowHasValue = false;
  cell: { r: string | undefined; hasValue: boolean } | undefined = undefined;
  /** Rows pushed so far (the library's rowIndexShift + rows.length). */
  held = 0;
  rowCount = 0;
  dataRowCount = 0;
  dataColumnCount = 0;
  ambiguous = false;
  /** The library would throw here: it reads nothing further. */
  failed = false;

  open(name: string, attrs: () => Record<string, string>): void {
    if (name === 'sheetData') {
      // A second one would reset the library's counts; real sheets have one.
      if (this.sheetDataSeen) this.ambiguous = true;
      this.sheetDataSeen = true;
      this.inSheetData = true;
    } else if (!this.inSheetData) {
      return;
    } else if (name === 'row') {
      const r = attrs().r;
      if (r) this.rowNumber = Number(r);
      this.rowOpen = true;
      this.rowHasValue = false;
    } else if (name === 'c') {
      this.cell = { r: attrs().r, hasValue: false };
    } else if (this.cell !== undefined && (name === 'v' || name === 'is')) {
      this.cell.hasValue = true;
    }
  }

  close(name: string): void {
    if (!this.inSheetData) return;
    if (name === 'row') {
      const n = this.rowNumber;
      if (n) {
        if (n <= this.held) {
          this.failed = true;
          return;
        }
        // Empty rows fill the gap up to the row's number.
        if (n > this.held + 1) this.held = Math.ceil(n) - 1;
      }
      this.held += 1;
      if (this.rowHasValue) this.dataRowCount = Math.max(this.dataRowCount, n ?? 0);
      if (n !== undefined && n > this.rowCount) this.rowCount = n;
      this.rowOpen = false;
      this.rowNumber = undefined;
      this.rowHasValue = false;
    } else if (name === 'c') {
      const address = this.cell?.r === undefined ? null : cellAddress(this.cell.r);
      if (address === null) {
        this.failed = true;
        return;
      }
      const [row, column] = address;
      // Like the library: a missing, zero or unreadable row number takes the cell's row.
      if (this.rowNumber === undefined || this.rowNumber === 0 || Number.isNaN(this.rowNumber)) {
        this.rowNumber = row;
      }
      if (this.cell?.hasValue === true) {
        if (!this.rowOpen) {
          this.failed = true;
          return;
        }
        this.rowHasValue = true;
        this.dataColumnCount = Math.max(this.dataColumnCount, column);
      }
      this.cell = undefined;
    }
  }

  bounds(): SheetBounds {
    return {
      rows: this.held,
      // Rows past the last one holding a value are dropped, unless it is the last row.
      keptRows:
        this.dataRowCount < this.rowCount ? Math.min(this.held, this.dataRowCount) : this.held,
      dataRows: this.dataRowCount,
      dataColumns: this.dataColumnCount,
      ambiguous: this.ambiguous,
    };
  }
}

const isNameStart = (w: number) =>
  (w > 96 && w < 123) || (w > 64 && w < 91) || w === 95 || w === 58;
const isNameChar = (w: number) =>
  (w > 96 && w < 123) ||
  (w > 64 && w < 91) ||
  (w > 47 && w < 59) ||
  w === 45 ||
  w === 95 ||
  w === 46;

/**
 * The first `char` at or after `from`, for positions that only grow: each part of the text
 * is searched once, so a tag with a million quoted values stays linear.
 */
function nextOf(xml: string, char: string) {
  let found = -2;
  return (from: number): number => {
    if (found === -1 || found >= from) return found;
    found = xml.indexOf(char, from);
    return found;
  };
}

/** The tokenizer's main loop over a whole string, driving the counter. */
function tokenize(xml: string, counter: SheetCounter): void {
  const nextLt = nextOf(xml, '<');
  const nextGt = nextOf(xml, '>');
  let j = 0;
  while (!counter.failed) {
    const i = xml.indexOf('<', j);
    if (i === -1) return;
    const w = xml.charCodeAt(i + 1);
    if (w === 33 && xml.charCodeAt(i + 2) === 91 && xml.startsWith('CDATA[', i + 3)) {
      const end = xml.indexOf(']]>', i);
      if (end === -1) return;
      j = end + 3;
      continue;
    }
    if (w === 33 && xml.charCodeAt(i + 2) === 45 && xml.charCodeAt(i + 3) === 45) {
      const end = xml.indexOf('-->', i);
      if (end === -1) return;
      j = end + 3;
      continue;
    }
    if (w === 63) {
      const end = xml.indexOf('?>', i);
      if (end === -1) return;
      j = end + 2;
      continue;
    }
    // The tag ends at the first '>' outside quotes; an unmatched quote is a plain character.
    let end = -1;
    let quotedGt = false;
    for (let x = i + 1; x < xml.length; x++) {
      const v = xml.charCodeAt(x);
      if (v === 34 || v === 39) {
        const q = xml.indexOf(v === 34 ? '"' : "'", x + 1);
        if (q === -1) continue;
        const lt = nextLt(x + 1);
        if (lt !== -1 && lt < q) counter.ambiguous = true;
        const gt = nextGt(x + 1);
        if (gt !== -1 && gt < q) quotedGt = true;
        x = q;
      } else if (v === 62) {
        end = x;
        break;
      }
    }
    if (end === -1) return;
    j = end + 1;
    if (w === 33) continue;
    if (w === 47) {
      let nameEnd = i + 2;
      while (nameEnd < end && !isSpace(xml.charCodeAt(nameEnd))) nameEnd++;
      counter.close(trimXmlnsPrefix(xml.substring(i + 2, nameEnd)));
      continue;
    }
    const selfClosing = xml.charCodeAt(end - 1) === 47;
    const tag = xml.substring(i + 1, selfClosing ? end - 1 : end);
    if (!isNameStart(w)) return;
    let nameEnd = tag.length;
    for (let q = 1; q < tag.length; q++) {
      const c = tag.charCodeAt(q);
      if (isNameChar(c)) continue;
      if (!isSpace(c)) return;
      nameEnd = q;
      break;
    }
    const name = trimXmlnsPrefix(tag.substring(0, nameEnd));
    if (quotedGt && (name === 'row' || name === 'c')) counter.ambiguous = true;
    counter.open(name, () => attributesOf(tag, nameEnd));
    if (selfClosing) counter.close(name);
  }
}

const SHEET_DATA = Buffer.from('sheetData');

/** Bounds of what the library would build from this entry (decoded as the library does). */
export function scanSheet(bytes: Uint8Array): SheetBounds {
  // The library reads rows only inside a <sheetData> element.
  if (Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).indexOf(SHEET_DATA) === -1) {
    return EMPTY;
  }
  const counter = new SheetCounter();
  tokenize(new TextDecoder().decode(bytes), counter);
  return counter.bounds();
}
