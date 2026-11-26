// Machine-managed blocks inside a note body. Everything outside frontmatter and outside these blocks belongs
// to the person; machines change only the text between the two marker lines of a block they own:
//
//   <!-- aios:begin nhat-ky -->
//   …written by the app…
//   <!-- aios:end nhat-ky -->
import { splitFrontmatter } from './frontmatter.js';

export const BLOCK_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MARKER_RE = /^[ \t]*<!--[ \t]*aios:(begin|end)[ \t]+([^\s]+)[ \t]*-->[ \t]*$/;

export class NoteBlockError extends Error {
  readonly code = 'bad_request';
  constructor(message: string) {
    super(message);
    this.name = 'NoteBlockError';
  }
}

const begin = (name: string) => `<!-- aios:begin ${name} -->`;
const end = (name: string) => `<!-- aios:end ${name} -->`;

interface Line {
  text: string;
  /** offset of the first char of the line */
  start: number;
  /** offset just past the line's newline (or end of text) */
  next: number;
}

function lines(text: string): Line[] {
  const out: Line[] = [];
  let i = 0;
  while (i < text.length) {
    const nl = text.indexOf('\n', i);
    const stop = nl === -1 ? text.length : nl + 1;
    out.push({ text: text.slice(i, nl === -1 ? text.length : nl).replace(/\r$/, ''), start: i, next: stop });
    i = stop;
  }
  return out;
}

/** Where the block's content sits in `body`: [from, to) between the marker lines. Throws on a broken block. */
function locate(body: string, name: string): { from: number; to: number } | undefined {
  let open: Line | undefined;
  let found: { from: number; to: number } | undefined;
  for (const l of lines(body)) {
    const m = MARKER_RE.exec(l.text);
    if (!m || m[2] !== name) continue;
    if (m[1] === 'begin') {
      if (open || found) throw new NoteBlockError(`Khối "${name}" xuất hiện hai lần trong ghi chú.`);
      open = l;
    } else {
      if (!open) throw new NoteBlockError(`Khối "${name}" có dòng kết thúc mà không có dòng bắt đầu.`);
      found = { from: open.next, to: l.start };
      open = undefined;
    }
  }
  if (open) throw new NoteBlockError(`Khối "${name}" thiếu dòng kết thúc.`);
  return found;
}

function checkName(name: string): void {
  if (!BLOCK_NAME_RE.test(name)) throw new NoteBlockError(`Tên khối "${name}" không hợp lệ (chữ thường, số, gạch ngang).`);
}

/** Content of block `name`, or undefined when the note has no such block. */
export function readBlock(text: string, name: string): string | undefined {
  checkName(name);
  const { body } = splitFrontmatter(text);
  const at = locate(body, name);
  return at ? body.slice(at.from, at.to) : undefined;
}

/**
 * Replace the content of block `name` with `markdown` (a final newline is added when missing). When the note
 * has no such block, it is appended at the end of the body after a blank line. Nothing outside the block moves.
 */
export function setBlock(text: string, name: string, markdown: string): string {
  checkName(name);
  if (markdown.split(/\r?\n/).some((l) => MARKER_RE.test(l))) throw new NoteBlockError('Nội dung khối không được chứa dòng đánh dấu aios:begin/aios:end.');
  const { head, body } = splitFrontmatter(text);
  const nl = /\r\n/.test(text) ? '\r\n' : '\n';
  const content = markdown === '' ? '' : markdown.replace(/\r?\n/g, nl).replace(/(?:\r?\n)?$/, nl);
  const at = locate(body, name);
  if (at) return head + body.slice(0, at.from) + content + body.slice(at.to);
  const sep = body === '' ? '' : /\r?\n\r?\n$/.test(body) ? '' : /\r?\n$/.test(body) ? nl : nl + nl;
  return head + body + sep + begin(name) + nl + content + end(name) + nl;
}
