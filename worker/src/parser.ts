/**
 * FAA NAS Status XML parser — a line-for-line port of ingest/parser.py.
 *
 * Workers have no DOMParser, so this includes a small strict XML reader that
 * reproduces the Python ElementTree behaviours the pipeline depends on:
 *   - element .text = character data before the first child, .tail = after
 *   - comments and processing instructions dropped, surrounding text joined
 *   - entity / character-reference decoding, CRLF -> LF normalisation,
 *     attribute-value whitespace normalisation (expat rules)
 *   - ET.tostring() serialisation for the `raw` column (`<x />` for empty
 *     elements, ET's exact escaping)
 * Parity with the Python parser is verified by test/parity.test.ts, which runs
 * both implementations over the fixture, the live feed, and every snapshot
 * stored in production.
 */

export interface XNode {
  tag: string;
  attrs: [string, string][];
  text: string;
  tail: string;
  children: XNode[];
}

export interface ObservationRecord {
  airport: string;
  delay_type: "delay" | "closure" | "ground_delay" | "ground_stop";
  direction: string | null;
  reason: string | null;
  min_delay_minutes: number | null;
  max_delay_minutes: number | null;
  trend: string | null;
  start_text: string | null;
  reopen_text: string | null;
  raw: string;
}

export interface ParsedFeed {
  update_time: Date | null;
  records: ObservationRecord[];
}

// ---------------------------------------------------------------------------
// Python-compatible whitespace (str.isspace / unicode \s), so .strip() and
// regex \s behave identically to the Python pipeline.
// ---------------------------------------------------------------------------
const PY_WS =
  "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const PY_STRIP_RE = new RegExp(`^[${PY_WS}]+|[${PY_WS}]+$`, "g");

export function pyStrip(s: string): string {
  return s.replace(PY_STRIP_RE, "");
}

// ---------------------------------------------------------------------------
// Minimal strict XML reader
// ---------------------------------------------------------------------------
const NAME = "[A-Za-z_:][-A-Za-z0-9_:.]*";
const START_TAG_RE = new RegExp(
  `<(${NAME})((?:\\s+${NAME}\\s*=\\s*(?:"[^"<]*"|'[^'<]*'))*)\\s*(/?)>`,
  "y"
);
const ATTR_RE = new RegExp(`(${NAME})\\s*=\\s*(?:"([^"<]*)"|'([^'<]*)')`, "g");
const END_TAG_RE = new RegExp(`</(${NAME})\\s*>`, "y");

const NAMED_ENTITIES: Record<string, string> = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
};

function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&([^;&\s]*);?/g, (match, body: string) => {
    if (!match.endsWith(";")) throw new Error(`XML: malformed entity '${match}'`);
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const cp = parseInt(body.slice(2), 16);
      if (!/^[0-9a-fA-F]+$/.test(body.slice(2)) || !validCodePoint(cp))
        throw new Error(`XML: bad character reference '${match}'`);
      return String.fromCodePoint(cp);
    }
    if (body.startsWith("#")) {
      const cp = parseInt(body.slice(1), 10);
      if (!/^[0-9]+$/.test(body.slice(1)) || !validCodePoint(cp))
        throw new Error(`XML: bad character reference '${match}'`);
      return String.fromCodePoint(cp);
    }
    const named = NAMED_ENTITIES[body];
    if (named === undefined) throw new Error(`XML: undefined entity '${match}'`);
    return named;
  });
}

function validCodePoint(cp: number): boolean {
  return (
    cp === 0x9 || cp === 0xa || cp === 0xd ||
    (cp >= 0x20 && cp <= 0xd7ff) ||
    (cp >= 0xe000 && cp <= 0xfffd) ||
    (cp >= 0x10000 && cp <= 0x10ffff)
  );
}

export function parseXml(input: string): XNode {
  // XML end-of-line handling: CRLF and lone CR become LF before parsing.
  const src = input.replace(/\r\n?/g, "\n");
  let i = 0;
  let root: XNode | null = null;
  const stack: XNode[] = [];

  const appendText = (s: string) => {
    if (!s) return;
    const cur = stack[stack.length - 1];
    if (!cur) {
      if (pyStrip(s) !== "") throw new Error("XML: text outside the root element");
      return;
    }
    const last = cur.children[cur.children.length - 1];
    if (last) last.tail += s;
    else cur.text += s;
  };

  if (src.charCodeAt(0) === 0xfeff) i = 1; // BOM

  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt === -1) {
      appendText(decodeEntities(src.slice(i)));
      break;
    }
    if (lt > i) appendText(decodeEntities(src.slice(i, lt)));
    i = lt;

    if (src.startsWith("<!--", i)) {
      const end = src.indexOf("-->", i + 4);
      if (end === -1) throw new Error("XML: unterminated comment");
      i = end + 3;
    } else if (src.startsWith("<?", i)) {
      const end = src.indexOf("?>", i + 2);
      if (end === -1) throw new Error("XML: unterminated processing instruction");
      i = end + 2;
    } else if (src.startsWith("<![CDATA[", i)) {
      const end = src.indexOf("]]>", i + 9);
      if (end === -1) throw new Error("XML: unterminated CDATA section");
      appendText(src.slice(i + 9, end));
      i = end + 3;
    } else if (src.startsWith("<!DOCTYPE", i)) {
      if (root || stack.length) throw new Error("XML: misplaced DOCTYPE");
      const end = src.indexOf(">", i);
      if (end === -1 || src.slice(i, end).includes("[")) {
        throw new Error("XML: unsupported DOCTYPE");
      }
      i = end + 1;
    } else if (src.startsWith("</", i)) {
      END_TAG_RE.lastIndex = i;
      const m = END_TAG_RE.exec(src);
      if (!m) throw new Error(`XML: malformed end tag at ${i}`);
      const open = stack.pop();
      if (!open || open.tag !== m[1]) {
        throw new Error(`XML: mismatched end tag </${m[1]}> at ${i}`);
      }
      i += m[0].length;
    } else {
      START_TAG_RE.lastIndex = i;
      const m = START_TAG_RE.exec(src);
      if (!m) throw new Error(`XML: malformed start tag at ${i}`);
      const node: XNode = { tag: m[1], attrs: [], text: "", tail: "", children: [] };
      const seen = new Set<string>();
      for (const a of m[2].matchAll(ATTR_RE)) {
        if (seen.has(a[1])) throw new Error(`XML: duplicate attribute '${a[1]}'`);
        seen.add(a[1]);
        const rawValue = a[2] ?? a[3] ?? "";
        // Attribute-value normalisation: literal tab/LF become spaces
        // (CR was already folded into LF above). Char refs survive as-is.
        node.attrs.push([a[1], decodeEntities(rawValue.replace(/[\t\n]/g, " "))]);
      }
      const parent = stack[stack.length - 1];
      if (parent) parent.children.push(node);
      else if (root) throw new Error("XML: multiple root elements");
      else root = node;
      if (m[3] !== "/") stack.push(node);
      i += m[0].length;
    }
  }

  if (stack.length) throw new Error(`XML: unclosed element <${stack[stack.length - 1].tag}>`);
  if (!root) throw new Error("XML: no root element");
  return root;
}

// ---------------------------------------------------------------------------
// ElementTree-compatible helpers
// ---------------------------------------------------------------------------
function escapeCdata(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttrib(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\r/g, "&#13;")
    .replace(/\n/g, "&#10;")
    .replace(/\t/g, "&#09;");
}

/** Equivalent of ET.tostring(node, encoding="unicode") — includes the tail. */
export function serialize(node: XNode): string {
  let out = "<" + node.tag;
  for (const [k, v] of node.attrs) out += ` ${k}="${escapeAttrib(v)}"`;
  if (node.text || node.children.length) {
    out += ">";
    if (node.text) out += escapeCdata(node.text);
    for (const c of node.children) out += serialize(c);
    out += `</${node.tag}>`;
  } else {
    out += " />";
  }
  if (node.tail) out += escapeCdata(node.tail);
  return out;
}

/** ET Element.findtext(tag): text of the first direct child, "" if no text. */
function findtext(node: XNode, tag: string): string | null {
  const child = node.children.find((c) => c.tag === tag);
  return child ? child.text : null;
}

function getAttr(node: XNode, name: string): string | null {
  const a = node.attrs.find(([k]) => k === name);
  return a ? a[1] : null;
}

// ---------------------------------------------------------------------------
// Port of ingest/parser.py
// ---------------------------------------------------------------------------
const HOUR_RE = new RegExp(`(\\d+)[${PY_WS}]*hour`, "i");
const MIN_RE = new RegExp(`(\\d+)[${PY_WS}]*minute`, "i");

export function parseDurationMinutes(text: string | null | undefined): number | null {
  if (!text) return null;
  const hours = HOUR_RE.exec(text);
  const minutes = MIN_RE.exec(text);
  if (!hours && !minutes) return null;
  let total = 0;
  if (hours) total += parseInt(hours[1], 10) * 60;
  if (minutes) total += parseInt(minutes[1], 10);
  return total;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

/**
 * Port of _parse_update_time: strptime("%a %b %d %H:%M:%S %Y %Z"), falling
 * back to dropping the final (timezone) token. The result is always UTC.
 * Matches Python's strptime: case-insensitive abbreviated names, 1–2 digit fields,
 * runs of whitespace, and calendar validation (e.g. Feb 30 -> null).
 */
export function parseUpdateTime(text: string | null): Date | null {
  if (!text) return null;
  const s = pyStrip(text);
  const ws = `[${PY_WS}]+`;
  const core =
    `([A-Za-z]+)${ws}([A-Za-z]+)${ws}(\\d{1,2})${ws}(\\d{1,2}):(\\d{1,2}):(\\d{1,2})${ws}(\\d{4})`;
  // Primary format requires a timezone token %Z accepts (UTC/GMT; the
  // GitHub runner's local zone was also UTC). Fallback: any final token.
  let m = new RegExp(`^${core}${ws}(UTC|GMT)$`, "i").exec(s);
  if (!m) {
    const tokens = s.split(new RegExp(ws));
    if (tokens.length < 2) return null;
    m = new RegExp(`^${core}$`, "i").exec(tokens.slice(0, -1).join(" "));
  }
  if (!m) return null;

  const [, dayName, monName, dd, hh, mi, ss, yyyy] = m;
  const dn = dayName.toLowerCase();
  // Python's %a / %b accept only the abbreviated names.
  if (!DAYS.includes(dn)) return null;
  const month = MONTHS.indexOf(monName.toLowerCase());
  if (month === -1) return null;

  const day = +dd, hour = +hh, minute = +mi, second = +ss, year = +yyyy;
  if (hour > 23 || minute > 59 || second > 61 || day < 1) return null;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const dim = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month];
  if (day > dim) return null;
  // Python's datetime cannot hold second 60/61 either; strptime raises.
  if (second > 59) return null;
  return new Date(Date.UTC(year, month, day, hour, minute, second));
}

function text(node: XNode, tag: string): string | null {
  const v = findtext(node, tag);
  return v ? pyStrip(v) : null;
}

function raw(node: XNode): string {
  return pyStrip(serialize(node));
}

function parseDelay(node: XNode): ObservationRecord[] {
  const airport = text(node, "ARPT");
  if (!airport) return [];
  const reason = text(node, "Reason");
  const r = raw(node);
  const out: ObservationRecord[] = [];
  for (const leg of node.children.filter((c) => c.tag === "Arrival_Departure")) {
    out.push({
      airport,
      delay_type: "delay",
      direction: getAttr(leg, "Type"),
      reason,
      min_delay_minutes: parseDurationMinutes(text(leg, "Min")),
      max_delay_minutes: parseDurationMinutes(text(leg, "Max")),
      trend: text(leg, "Trend"),
      start_text: null,
      reopen_text: null,
      raw: r,
    });
  }
  if (out.length === 0) {
    out.push({
      airport, delay_type: "delay", direction: null, reason,
      min_delay_minutes: null, max_delay_minutes: null, trend: null,
      start_text: null, reopen_text: null, raw: r,
    });
  }
  return out;
}

function parseClosure(node: XNode): ObservationRecord[] {
  const airport = text(node, "ARPT");
  if (!airport) return [];
  return [{
    airport, delay_type: "closure", direction: null,
    reason: text(node, "Reason"),
    min_delay_minutes: null, max_delay_minutes: null, trend: null,
    start_text: text(node, "Start"),
    reopen_text: text(node, "Reopen"),
    raw: raw(node),
  }];
}

function parseGroundDelay(node: XNode): ObservationRecord[] {
  const airport = text(node, "ARPT");
  if (!airport) return [];
  return [{
    airport, delay_type: "ground_delay", direction: null,
    reason: text(node, "Reason"),
    min_delay_minutes: parseDurationMinutes(text(node, "Avg")),
    max_delay_minutes: parseDurationMinutes(text(node, "Max")),
    trend: null, start_text: null, reopen_text: null,
    raw: raw(node),
  }];
}

function parseGroundStop(node: XNode): ObservationRecord[] {
  const airport = text(node, "ARPT");
  if (!airport) return [];
  return [{
    airport, delay_type: "ground_stop", direction: null,
    reason: text(node, "Reason"),
    min_delay_minutes: null, max_delay_minutes: null, trend: null,
    start_text: null,
    reopen_text: text(node, "End_Time"),
    raw: raw(node),
  }];
}

// Dispatch on the LIST element, not on <Name>: the feed legitimately repeats
// names (two distinct blocks are both called "Airport Closures").
const LIST_HANDLERS: Record<string, [string, (n: XNode) => ObservationRecord[]]> = {
  Arrival_Departure_Delay_List: ["Delay", parseDelay],
  Airport_Closure_List: ["Airport", parseClosure],
  Ground_Delay_List: ["Ground_Delay", parseGroundDelay],
  Ground_Stop_List: ["Program", parseGroundStop],
};

export function parseNasStatus(xmlText: string): ParsedFeed {
  const root = parseXml(xmlText);
  const updateTime = parseUpdateTime(findtext(root, "Update_Time"));
  const records: ObservationRecord[] = [];
  for (const block of root.children.filter((c) => c.tag === "Delay_type")) {
    for (const child of block.children) {
      const handler = LIST_HANDLERS[child.tag];
      if (!handler) continue;
      const [itemTag, parseItem] = handler;
      for (const item of child.children.filter((c) => c.tag === itemTag)) {
        records.push(...parseItem(item));
      }
    }
  }
  return { update_time: updateTime, records };
}
