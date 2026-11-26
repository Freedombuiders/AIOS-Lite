// Logic of the bottom command bar (components/CommandBar.tsx): which pages hide it, and how a typed line plus
// attached files becomes one chat message. The chat API takes text only, so a file is sent as text inside the message.
import { matchRoute } from 'wouter-preact';
import type { useRouter } from 'wouter-preact';

type Parser = ReturnType<typeof useRouter>['parser'];

export const COMMAND_AGENT_KEY = 'aios.commandbar.agent';

/** The chat API's content limit is 100 000 characters; stay well under it. */
export const MAX_MESSAGE_CHARS = 90_000;
export const MAX_ATTACHMENT_CHARS = 30_000;
/** Only plain-text files can ride inside a message. */
export const TEXT_FILE = /\.(txt|md|markdown|csv|tsv|json|yaml|yml|log)$/i;

export interface RouteFlags {
  path: string;
  hideCommandBar?: boolean;
}

/** True when the page that wins the current location (first match, like the router's Switch) asked to hide the bar. */
export function commandBarHidden(loc: string, routes: readonly RouteFlags[], parser: Parser): boolean {
  const hit = routes.find((r) => matchRoute(parser, r.path, loc)[0]);
  return hit?.hideCommandBar === true;
}

export interface Attachment {
  name: string;
  text: string;
  truncated: boolean;
}

export function isTextFile(name: string): boolean {
  return TEXT_FILE.test(name);
}

function readText(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result ?? ''));
    r.onerror = () => reject(new Error('Không đọc được tệp.'));
    r.readAsText(file);
  });
}

export async function readAttachment(file: File): Promise<Attachment> {
  if (!isTextFile(file.name)) throw new Error(`Chưa gửi được tệp "${file.name}": hiện chỉ nhận tệp chữ (.txt, .md, .csv, .json…).`);
  const full = await readText(file);
  const truncated = full.length > MAX_ATTACHMENT_CHARS;
  return { name: file.name, text: truncated ? full.slice(0, MAX_ATTACHMENT_CHARS) : full, truncated };
}

/** The typed line first, then each file under its name. Returns null when there is nothing to send. */
export function composeMessage(text: string, files: readonly Attachment[]): string | null {
  const line = text.trim();
  if (!line && files.length === 0) return null;
  const parts = [line || 'Xem các tệp đính kèm.'];
  for (const f of files) {
    parts.push(`Tệp đính kèm: ${f.name}${f.truncated ? ' (đã cắt bớt cho vừa)' : ''}\n\`\`\`\n${f.text}\n\`\`\``);
  }
  return parts.join('\n\n').slice(0, MAX_MESSAGE_CHARS);
}

/** Enabled agents only; keeps the remembered one when it is still on, else the first. */
export function pickAgent(agents: readonly { id: string; enabled: boolean }[], remembered: string | null): string {
  const on = agents.filter((a) => a.enabled);
  return on.find((a) => a.id === remembered)?.id ?? on.find((a) => a.id === 'main')?.id ?? on[0]?.id ?? '';
}
