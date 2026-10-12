/**
 * PDF/A-3 renderer for true copies (Phase 4 slice 6b; D-P4-7, D-6-4; DI-41, DI-24 clause shown in the document).
 *
 * The renderer is pure: the same input gives the same bytes. Nothing in the file comes from the clock: the creation and
 * modification dates are the record's own (the time of the last audit event of the copied chain), the subset font names
 * are fixed, the trailer ID is derived from the content hash and every object is written in a fixed order.
 *
 * PDF/A-3 parts written here (veraPDF conformance stays a deployment check, D-P4-7):
 * - embedded, subset fonts only (Noto Sans for Latin, Noto Sans Devanagari for Devanagari runs; both SIL OFL 1.1, which
 *   allows embedding), with ToUnicode maps (pdf-lib's Type0 / CIDFontType2 embedding);
 * - an sRGB output intent (GTS_PDFA1) with an ICC v2 display profile built here from the sRGB primaries, D50 white point
 *   and the sRGB transfer curve (no profile file is needed offline);
 * - XMP metadata (pdfaid part 3, conformance B) agreeing with the document information dictionary; the content SHA-256
 *   is in dc:identifier-free predefined fields only: the Keywords (pdf:Keywords) and the Subject (dc:description), so no
 *   extension schema is needed;
 * - the record's canonical JSON as associated files (/AF on the catalog, /AFRelationship Source or Data on each file
 *   specification, MIME subtype and dates on each embedded file), unfiltered so the database finds each byte for byte.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
// @pdf-lib/fontkit's bundle calls a global regeneratorRuntime in its Indic (Devanagari) shaper; this pinned runtime
// provides it (it must load before the shaper runs).
import 'regenerator-runtime/runtime.js';
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, PDFHexString, PDFName, PDFString, rgb, type PDFFont, type PDFPage, type PDFRef } from 'pdf-lib';

export const PDFA_RENDERER_VERSION = 'ebmr.pdfa3-true-copy/1';

export interface PdfaSection {
  heading: string;
  lines: string[];
}

export interface PdfaAttachment {
  /** File name in the PDF (sorted by name in the name tree). */
  name: string;
  mediaType: 'application/json' | 'text/plain';
  description: string;
  relationship: 'Source' | 'Data' | 'Supplement';
  text: string;
}

export interface PdfaInput {
  title: string;
  /** Plain-text subject line shown under the title and stored as the document subject. */
  subject: string;
  /** The record's own instant (ISO 8601, UTC), used as the creation and modification date. Never the clock. */
  recordDate: string;
  /** SHA-256 (hex) of the record's canonical content; in the metadata and printed on every page. */
  contentSha256: string;
  /** Statement printed at the top (the DI-24 clause: originals are preserved and shown). */
  integrityClause: string;
  sections: PdfaSection[];
  attachments: PdfaAttachment[];
}

const require = createRequire(import.meta.url);
let fontCache: { latin: Uint8Array; devanagari: Uint8Array } | null = null;

function fonts(): { latin: Uint8Array; devanagari: Uint8Array } {
  if (!fontCache) {
    fontCache = {
      latin: readFileSync(require.resolve('@fontsource/noto-sans/files/noto-sans-latin-400-normal.woff')),
      devanagari: readFileSync(require.resolve('@fontsource/noto-sans-devanagari/files/noto-sans-devanagari-devanagari-400-normal.woff')),
    };
  }
  return fontCache;
}

// ---------------------------------------------------------------------------------------------------------------------
// sRGB ICC v2 profile (display class, RGB to XYZ, D50 PCS), built deterministically.
// ---------------------------------------------------------------------------------------------------------------------

function s15Fixed16(v: number): number {
  return Math.round(v * 65536) | 0;
}

/** ICC.1:2001-04 (v2.1) profile with the sRGB primaries adapted to D50 and the sRGB tone curve as a 1024-entry table. */
export function srgbIccProfile(): Uint8Array {
  const text = (s: string): Uint8Array => {
    const b = new Uint8Array(8 + s.length + 1);
    b.set([0x74, 0x65, 0x78, 0x74], 0); // 'text', reserved, NUL-terminated ASCII
    for (let i = 0; i < s.length; i++) b[8 + i] = s.charCodeAt(i);
    return b;
  };
  const desc = (s: string): Uint8Array => {
    // 'desc' type: ASCII count + string + NUL, empty Unicode and ScriptCode parts.
    const ascii = s.length + 1;
    const b = new Uint8Array(12 + ascii + 4 + 4 + 2 + 1 + 67);
    const dv = new DataView(b.buffer);
    b.set([0x64, 0x65, 0x73, 0x63], 0);
    dv.setUint32(8, ascii);
    for (let i = 0; i < s.length; i++) b[12 + i] = s.charCodeAt(i);
    return b;
  };
  const xyz = (x: number, y: number, z: number): Uint8Array => {
    const b = new Uint8Array(20);
    const dv = new DataView(b.buffer);
    b.set([0x58, 0x59, 0x5a, 0x20], 0);
    dv.setInt32(8, s15Fixed16(x));
    dv.setInt32(12, s15Fixed16(y));
    dv.setInt32(16, s15Fixed16(z));
    return b;
  };
  const curve = (): Uint8Array => {
    const n = 1024;
    const b = new Uint8Array(12 + 2 * n);
    const dv = new DataView(b.buffer);
    b.set([0x63, 0x75, 0x72, 0x76], 0);
    dv.setUint32(8, n);
    for (let i = 0; i < n; i++) {
      const c = i / (n - 1);
      const lin = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      dv.setUint16(12 + 2 * i, Math.round(lin * 65535));
    }
    return b;
  };
  const trc = curve();
  const tags: [string, Uint8Array][] = [
    ['desc', desc('sRGB IEC61966-2.1 (eBMR built-in)')],
    ['cprt', text('No copyright, use freely')],
    ['wtpt', xyz(0.9642, 1.0, 0.8249)],
    ['rXYZ', xyz(0.4361, 0.2225, 0.0139)],
    ['gXYZ', xyz(0.3851, 0.7169, 0.0971)],
    ['bXYZ', xyz(0.1431, 0.0606, 0.7141)],
    ['rTRC', trc],
    ['gTRC', trc],
    ['bTRC', trc],
  ];
  const pad4 = (n: number) => (n + 3) & ~3;
  let offset = 128 + 4 + tags.length * 12;
  const placed: { sig: string; at: number; data: Uint8Array }[] = [];
  const seen = new Map<Uint8Array, number>();
  for (const [sig, data] of tags) {
    const shared = seen.get(data);
    if (shared !== undefined) {
      placed.push({ sig, at: shared, data });
      continue;
    }
    offset = pad4(offset);
    placed.push({ sig, at: offset, data });
    seen.set(data, offset);
    offset += data.length;
  }
  const size = pad4(offset);
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i);
  };
  dv.setUint32(0, size);
  ascii(4, 'none');
  dv.setUint32(8, 0x02100000); // version 2.1
  ascii(12, 'mntr');
  ascii(16, 'RGB ');
  ascii(20, 'XYZ ');
  // date 2026-01-01 00:00:00 (fixed; the profile is the same in every document)
  dv.setUint16(24, 2026);
  dv.setUint16(26, 1);
  dv.setUint16(28, 1);
  ascii(36, 'acsp');
  dv.setUint32(64, 0); // rendering intent: perceptual
  dv.setInt32(68, s15Fixed16(0.9642));
  dv.setInt32(72, s15Fixed16(1.0));
  dv.setInt32(76, s15Fixed16(0.8249));
  dv.setUint32(128, tags.length);
  placed.forEach((p, i) => {
    ascii(132 + i * 12, p.sig);
    dv.setUint32(136 + i * 12, p.at);
    dv.setUint32(140 + i * 12, p.data.length);
    if (seen.get(p.data) === p.at) out.set(p.data, p.at);
  });
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Text layout
// ---------------------------------------------------------------------------------------------------------------------

const PAGE_W = 595.28; // A4
const PAGE_H = 841.89;
const MARGIN = 48;
const BODY_SIZE = 8.5;
const LEADING = 11.5;

const isDevanagari = (cp: number) => (cp >= 0x0900 && cp <= 0x097f) || (cp >= 0xa8e0 && cp <= 0xa8ff) || cp === 0x200c || cp === 0x200d;

interface Run {
  text: string;
  deva: boolean;
}

interface Fonts {
  latin: PDFFont;
  devanagari: PDFFont;
  hasLatin: (cp: number) => boolean;
  hasDeva: (cp: number) => boolean;
}

/** Splits a line into script runs; a code point no embedded font draws becomes '?'. */
function runsOf(line: string, f: Fonts): Run[] {
  const runs: Run[] = [];
  for (const ch of line) {
    const cp = ch.codePointAt(0) ?? 0x3f;
    const deva = isDevanagari(cp);
    let c = ch;
    if (cp < 0x20) c = ' ';
    else if (deva ? !f.hasDeva(cp) && cp !== 0x200c && cp !== 0x200d : !f.hasLatin(cp)) c = '?';
    const last = runs[runs.length - 1];
    if (last && last.deva === deva) last.text += c;
    else runs.push({ text: c, deva });
  }
  return runs;
}

/**
 * Wraps a line to the width in one pass: each character's advance at size 1 (cached per font), a break at the last
 * space when there is one, else a hard break. Devanagari widths are taken per character (shaping may make a cluster
 * narrower, never much wider), with a 3 % reserve.
 */
function wrap(line: string, f: Fonts, size: number, width: number): string[] {
  if (line === '') return [''];
  const limit = (width * 0.97) / size;
  const out: string[] = [];
  const chars = runsOf(line, f).flatMap((r) => [...r.text].map((c) => ({ c, deva: r.deva })));
  let start = 0;
  let w = 0;
  let lastSpace = -1;
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i] as { c: string; deva: boolean };
    const cw = charWidth(ch.c, ch.deva, f);
    if (w + cw > limit && i > start) {
      const cut = lastSpace > start ? lastSpace + 1 : i;
      out.push(chars.slice(start, cut).map((x) => x.c).join('').trimEnd());
      start = cut;
      lastSpace = -1;
      w = chars.slice(start, i).reduce((s, x) => s + charWidth(x.c, x.deva, f), 0);
    }
    if (ch.c === ' ') lastSpace = i;
    w += cw;
  }
  out.push(chars.slice(start).map((x) => x.c).join(''));
  return out;
}

const widthCache = new WeakMap<PDFFont, Map<string, number>>();
function charWidth(c: string, deva: boolean, f: Fonts): number {
  const font = deva ? f.devanagari : f.latin;
  let m = widthCache.get(font);
  if (!m) widthCache.set(font, (m = new Map<string, number>()));
  let v = m.get(c);
  if (v === undefined) {
    v = font.widthOfTextAtSize(c, 1);
    m.set(c, v);
  }
  return v;
}

class Writer {
  page!: PDFPage;
  y = 0;
  pageNo = 0;
  readonly pages: PDFPage[] = [];
  constructor(
    private readonly doc: PDFDocument,
    private readonly f: Fonts,
    private readonly footer: string,
  ) {
    this.newPage();
  }
  newPage(): void {
    this.page = this.doc.addPage([PAGE_W, PAGE_H]);
    this.pages.push(this.page);
    this.pageNo++;
    this.y = PAGE_H - MARGIN;
  }
  draw(text: string, size: number, indent = 0, grey = false): void {
    for (const piece of wrap(text, this.f, size, PAGE_W - 2 * MARGIN - indent)) {
      if (this.y < MARGIN + 2 * LEADING) this.newPage();
      let x = MARGIN + indent;
      for (const r of runsOf(piece, this.f)) {
        const font = r.deva ? this.f.devanagari : this.f.latin;
        this.page.drawText(r.text, { x, y: this.y, size, font, color: grey ? rgb(0.35, 0.35, 0.35) : rgb(0, 0, 0) });
        x += font.widthOfTextAtSize(r.text, size);
      }
      this.y -= size >= 12 ? size * 1.5 : LEADING;
    }
  }
  gap(h = LEADING / 2): void {
    this.y -= h;
  }
  finish(): void {
    const total = this.pages.length;
    this.pages.forEach((p, i) => {
      const text = `${this.footer}   Page ${i + 1} of ${total}`;
      let x = MARGIN;
      for (const r of runsOf(text, this.f)) {
        const font = r.deva ? this.f.devanagari : this.f.latin;
        p.drawText(r.text, { x, y: MARGIN / 2, size: 7, font, color: rgb(0.35, 0.35, 0.35) });
        x += font.widthOfTextAtSize(r.text, 7);
      }
    });
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------------------------------------------------

const xmlEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function isoSeconds(instant: string): string {
  const d = new Date(instant);
  if (Number.isNaN(d.getTime())) throw new Error(`EBMR-REC-110 the record date ${instant} is no instant`);
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function xmp(input: PdfaInput, keywords: string, producer: string): string {
  const date = isoSeconds(input.recordDate);
  return [
    '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>',
    '<x:xmpmeta xmlns:x="adobe:ns:meta/">',
    '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
    '<rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">',
    '<pdfaid:part>3</pdfaid:part><pdfaid:conformance>B</pdfaid:conformance>',
    '</rdf:Description>',
    '<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">',
    '<dc:format>application/pdf</dc:format>',
    `<dc:title><rdf:Alt><rdf:li xml:lang="x-default">${xmlEscape(input.title)}</rdf:li></rdf:Alt></dc:title>`,
    `<dc:description><rdf:Alt><rdf:li xml:lang="x-default">${xmlEscape(input.subject)}</rdf:li></rdf:Alt></dc:description>`,
    '</rdf:Description>',
    '<rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/">',
    `<xmp:CreateDate>${date}</xmp:CreateDate><xmp:ModifyDate>${date}</xmp:ModifyDate><xmp:MetadataDate>${date}</xmp:MetadataDate>`,
    `<xmp:CreatorTool>${xmlEscape(PDFA_RENDERER_VERSION)}</xmp:CreatorTool>`,
    '</rdf:Description>',
    '<rdf:Description rdf:about="" xmlns:pdf="http://ns.adobe.com/pdf/1.3/">',
    `<pdf:Producer>${xmlEscape(producer)}</pdf:Producer><pdf:Keywords>${xmlEscape(keywords)}</pdf:Keywords>`,
    '</rdf:Description>',
    '</rdf:RDF>',
    '</x:xmpmeta>',
    '<?xpacket end="r"?>',
  ].join('\n');
}

export const contentKeyword = (sha256: string) => `ebmr-content-sha256:${sha256}`;

/** Renders the PDF/A-3 document. Same input, same bytes. */
export async function renderPdfA3(input: PdfaInput): Promise<Uint8Array> {
  if (!/^[0-9a-f]{64}$/.test(input.contentSha256)) throw new Error('EBMR-REC-110 the content SHA-256 is no SHA-256');
  const when = new Date(isoSeconds(input.recordDate));
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.registerFontkit(fontkit);
  const raw = fonts();
  const latinFace = fontkit.create(Buffer.from(raw.latin));
  const devaFace = fontkit.create(Buffer.from(raw.devanagari));
  const f: Fonts = {
    latin: await doc.embedFont(raw.latin, { subset: true, customName: 'EBMRAA+NotoSans-Regular' }),
    devanagari: await doc.embedFont(raw.devanagari, { subset: true, customName: 'EBMRAB+NotoSansDevanagari-Regular' }),
    hasLatin: (cp) => latinFace.hasGlyphForCodePoint(cp),
    hasDeva: (cp) => devaFace.hasGlyphForCodePoint(cp),
  };
  const producer = `${PDFA_RENDERER_VERSION} (pdf-lib 1.17.1)`;
  const keywords = `${contentKeyword(input.contentSha256)}; PDF/A-3B; true copy`;

  const w = new Writer(doc, f, `${input.title}   ${contentKeyword(input.contentSha256)}`);
  w.draw(input.title, 14);
  w.draw(input.subject, 9, 0, true);
  w.draw(`Record date: ${isoSeconds(input.recordDate)}   Content SHA-256: ${input.contentSha256}`, 8, 0, true);
  w.gap();
  w.draw(input.integrityClause, 9);
  w.gap();
  w.draw(`Associated files: ${[...input.attachments].map((a) => a.name).sort().join(', ')}`, 8, 0, true);
  for (const s of input.sections) {
    w.gap(LEADING);
    w.draw(s.heading, 11);
    for (const line of s.lines) w.draw(line, BODY_SIZE, 8);
  }
  w.finish();

  doc.setTitle(input.title);
  doc.setSubject(input.subject);
  doc.setKeywords([keywords]);
  doc.setProducer(producer);
  doc.setCreator(PDFA_RENDERER_VERSION);
  doc.setCreationDate(when);
  doc.setModificationDate(when);
  doc.setLanguage('en');

  const ctx = doc.context;
  const meta = ctx.stream(new TextEncoder().encode(xmp(input, keywords, producer)), { Type: 'Metadata', Subtype: 'XML' });
  doc.catalog.set(PDFName.of('Metadata'), ctx.register(meta));
  const icc = ctx.flateStream(srgbIccProfile(), { N: 3 });
  const intent = ctx.obj({
    Type: 'OutputIntent',
    S: 'GTS_PDFA1',
    OutputConditionIdentifier: PDFString.of('sRGB IEC61966-2.1'),
    RegistryName: PDFString.of('http://www.color.org'),
    Info: PDFString.of('sRGB IEC61966-2.1'),
    DestOutputProfile: ctx.register(icc),
  });
  doc.catalog.set(PDFName.of('OutputIntents'), ctx.obj([ctx.register(intent)]));
  const id = createHash('sha256').update(`${PDFA_RENDERER_VERSION}:${input.contentSha256}`).digest('hex').slice(0, 32);
  ctx.trailerInfo.ID = ctx.obj([PDFHexString.of(id), PDFHexString.of(id)]);

  // The associated files, unfiltered (the database finds each one byte for byte in the file, kernel 1174), in name order
  // in the EmbeddedFiles name tree and in the catalog's /AF array.
  const names: (PDFHexString | PDFRef)[] = [];
  const specs: PDFRef[] = [];
  for (const a of [...input.attachments].sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0))) {
    const bytes = new TextEncoder().encode(a.text);
    const file = ctx.stream(bytes, {
      Type: 'EmbeddedFile',
      Subtype: a.mediaType,
      Params: { Size: bytes.length, CreationDate: PDFString.fromDate(when), ModDate: PDFString.fromDate(when) },
    });
    const spec = ctx.register(
      ctx.obj({
        Type: 'Filespec',
        F: PDFString.of(a.name),
        UF: PDFHexString.fromText(a.name),
        EF: { F: ctx.register(file) },
        Desc: PDFHexString.fromText(a.description),
        AFRelationship: a.relationship,
      }),
    );
    names.push(PDFHexString.fromText(a.name), spec);
    specs.push(spec);
  }
  doc.catalog.set(PDFName.of('Names'), ctx.obj({ EmbeddedFiles: ctx.obj({ Names: ctx.obj(names) }) }));
  doc.catalog.set(PDFName.of('AF'), ctx.obj(specs));
  return doc.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false });
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading back (for the verifier): the associated files and the keywords
// ---------------------------------------------------------------------------------------------------------------------

export interface PdfaContents {
  keywords: string | null;
  attachments: Map<string, string>;
  hasOutputIntent: boolean;
  hasXmp: boolean;
  catalogAf: number;
}

/** Reads the associated files and the metadata back out of a PDF made by renderPdfA3. */
export async function readPdfA3(bytes: Uint8Array): Promise<PdfaContents> {
  const { PDFDict, PDFArray, PDFRawStream, PDFRef, decodePDFRawStream } = await import('pdf-lib');
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const attachments = new Map<string, string>();
  const names = doc.catalog.lookupMaybe(PDFName.of('Names'), PDFDict);
  const ef = names?.lookupMaybe(PDFName.of('EmbeddedFiles'), PDFDict);
  const list = ef?.lookupMaybe(PDFName.of('Names'), PDFArray);
  if (list) {
    for (let i = 0; i + 1 < list.size(); i += 2) {
      const spec = list.lookup(i + 1, PDFDict);
      const file = spec.lookup(PDFName.of('EF'), PDFDict).lookup(PDFName.of('F'));
      const nameObj = spec.lookup(PDFName.of('UF'));
      const name = nameObj instanceof PDFHexString || nameObj instanceof PDFString ? nameObj.decodeText() : String(i / 2);
      if (file instanceof PDFRawStream) attachments.set(name, new TextDecoder().decode(decodePDFRawStream(file).decode()));
    }
  }
  const af = doc.catalog.lookupMaybe(PDFName.of('AF'), PDFArray);
  void PDFRef;
  return {
    keywords: doc.getKeywords() ?? null,
    attachments,
    hasOutputIntent: doc.catalog.has(PDFName.of('OutputIntents')),
    hasXmp: doc.catalog.has(PDFName.of('Metadata')),
    catalogAf: af?.size() ?? 0,
  };
}
