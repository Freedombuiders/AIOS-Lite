// YAML frontmatter ("---" block at the top of a markdown note): read, and patch without touching the body.
import { isMap, isScalar, parse, parseDocument, stringify } from 'yaml';

/** BOM? · opening fence · yaml · closing fence (its own line) · body. An empty block (`---\n---`) counts. */
const FENCE_RE = /^(\uFEFF?)---(\r?\n)(?:([\s\S]*?)\r?\n)??---[ \t]*(?:\r?\n|$)/;

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

interface Split {
  bom: string;
  eol: string;
  yaml: string;
  body: string;
}

function split(text: string): Split | null {
  const m = FENCE_RE.exec(text);
  if (!m) return null;
  return { bom: m[1] ?? '', eol: m[2] ?? '\n', yaml: m[3] ?? '', body: text.slice(m[0].length) };
}

/** Throws when the block is not valid YAML. A block that is not a mapping reads as `{}`. */
export function parseFrontmatter(text: string): { data: Record<string, unknown>; body: string; has: boolean } {
  const s = split(text);
  if (!s) return { data: {}, body: text, has: false };
  const parsed: unknown = parse(s.yaml);
  return { data: isRecord(parsed) ? parsed : {}, body: s.body, has: true };
}

const STRINGIFY_OPTS = { lineWidth: 0 } as const;

/** File line ending: the fence's when there is a block, else the first newline in the text, else "\n". */
function eolOf(text: string, s: Split | null): string {
  if (s) return s.eol;
  const i = text.indexOf('\n');
  return i > 0 && text[i - 1] === '\r' ? '\r\n' : '\n';
}

function block(yaml: string, eol: string): string {
  const y = yaml.replace(/\r?\n$/, '');
  const lines = y === '' ? [] : y.split(/\r?\n/);
  return ['---', ...lines, '---'].join(eol) + eol;
}

/**
 * Set the keys in `patch` (value `undefined` = remove the key). Existing keys keep their order and comments,
 * new keys go last, the body is not touched by a single byte, and the file's line ending is kept.
 * Throws when the existing block is not valid YAML or not a mapping.
 */
export function writeFrontmatter(text: string, patch: Record<string, unknown>): string {
  const s = split(text);
  const eol = eolOf(text, s);
  if (!s) {
    const data = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    if (!Object.keys(data).length) return text;
    // a leading BOM stays first in the file
    const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
    return bom + block(stringify(data, STRINGIFY_OPTS), eol) + text.slice(bom.length);
  }
  const doc = parseDocument(s.yaml);
  if (doc.errors.length) throw doc.errors[0]!;
  if (doc.contents === null || (isScalar(doc.contents) && doc.contents.value == null)) doc.contents = doc.createNode({}) as unknown as typeof doc.contents;
  if (!isMap(doc.contents)) throw new Error('Khối thuộc tính đầu file không phải dạng khoá: giá trị.');
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) {
      doc.delete(k);
      continue;
    }
    const node = doc.get(k, true);
    // scalar → scalar: change the value in place so a trailing `# comment` survives
    if (isScalar(node) && (v === null || typeof v !== 'object')) node.value = v;
    else doc.set(k, v);
  }
  const yaml = doc.contents.items.length ? doc.toString(STRINGIFY_OPTS) : '';
  return s.bom + block(yaml, eol) + s.body;
}

/** A new note: frontmatter from `data` (key order kept) followed by `body`. */
export function composeNote(data: Record<string, unknown>, body: string): string {
  const eol = /\r\n/.test(body) ? '\r\n' : '\n';
  const clean = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
  return block(Object.keys(clean).length ? stringify(clean, STRINGIFY_OPTS) : '', eol) + body;
}
