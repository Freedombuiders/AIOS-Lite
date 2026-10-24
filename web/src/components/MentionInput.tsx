import type { RefObject, JSX } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';
import type { PickerAgent } from './AgentPicker';
import type { PickerSkill } from './SkillPicker';

export interface ComposerInput extends HTMLDivElement {
  readonly value: string;
  readonly selectionStart: number;
  setSelectionRange(start: number, end: number): void;
}

export function displayName(name: string | undefined, id: string) {
  return name?.trim() || id.replace(/-[a-f0-9]{6,}$/i, '').replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

interface Part { text: string; label?: string; kind?: 'agent' | 'skill' | 'folder'; title?: string }
export function mentionParts(value: string, agents: PickerAgent[], skills: PickerSkill[]): Part[] {
  const parts: Part[] = [];
  const pattern = /(^|\s)(@\[[^\[\]\r\n]+\]|\$[\p{L}][\p{L}\p{N}_-]*|\/skill\s+[^\s]+|\/[^\s]+)/gu;
  let cursor = 0;
  for (const match of value.matchAll(pattern)) {
    const token = match[2];
    const start = match.index! + match[1].length;
    const agent = token.startsWith('$') ? agents.find(a => a.id === token.slice(1)) : undefined;
    const skill = start === 0 && token.startsWith('/') ? skills.find(s => token === `/skill ${s.id}` || token === `/${s.command}` || token === `/${s.id}`) : undefined;
    const folder = token.startsWith('@[') ? token.slice(2, -1) : undefined;
    if (!agent && !skill && !folder) continue;
    if (start > cursor) parts.push({ text: value.slice(cursor, start) });
    parts.push({ text: token, label: folder ? folder.split('/').filter(Boolean).pop() || folder : displayName(agent?.name ?? skill?.name, (agent ?? skill)!.id), kind: folder ? 'folder' : agent ? 'agent' : 'skill', title: folder });
    cursor = start + token.length;
  }
  if (cursor < value.length) parts.push({ text: value.slice(cursor) });
  return parts;
}

function raw(node: Node): string {
  if (node instanceof HTMLElement && node.dataset.sentinel) return '';
  if (node instanceof HTMLElement && node.dataset.token) return node.dataset.token;
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
  if (node.nodeName === 'BR') return '\n';
  return Array.from(node.childNodes).map(raw).join('');
}

function caretOffset(root: HTMLElement) {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !root.contains(selection.focusNode)) return raw(root).length;
  const range = document.createRange();
  range.selectNodeContents(root);
  range.setEnd(selection.focusNode!, selection.focusOffset);
  return raw(range.cloneContents()).length;
}

function selectRange(root: HTMLElement, start: number, end: number) {
  function point(offset: number): [Node, number] {
    let remaining = offset;
    for (let i = 0; i < root.childNodes.length; i++) {
      const node = root.childNodes[i];
      const length = raw(node).length;
      if (remaining <= length) return node.nodeType === Node.TEXT_NODE
        ? [node, remaining] : [root, i + (remaining > 0 ? 1 : 0)];
      remaining -= length;
    }
    return [root, root.childNodes.length];
  }
  const range = document.createRange();
  range.setStart(...point(start)); range.setEnd(...point(end));
  const selection = window.getSelection();
  selection?.removeAllRanges(); selection?.addRange(range);
}

interface Props extends Omit<JSX.HTMLAttributes<HTMLDivElement>, 'value' | 'onInput' | 'onChange'> {
  inputRef: RefObject<ComposerInput>;
  value: string;
  agents: PickerAgent[];
  skills: PickerSkill[];
  placeholder: string;
  onChange(value: string): void;
  onCaret(): void;
}

/** The DOM shows names; the draft and selection offsets use canonical tokens. */
export function MentionInput({ inputRef, value, agents, skills, placeholder, onChange, onCaret, ...props }: Props) {
  const local = useRef<ComposerInput>(null);
  const composing = useRef(false);
  const renderKey = useRef('');
  const history = useRef([value]);
  const historyIndex = useRef(0);
  const parts = mentionParts(value, agents, skills);
  const key = JSON.stringify(parts);
  useLayoutEffect(() => {
    const root = local.current;
    if (!root) return;
    inputRef.current = root;
    if (history.current[historyIndex.current] !== value) {
      history.current = [...history.current.slice(0, historyIndex.current + 1), value].slice(-100);
      historyIndex.current = history.current.length - 1;
    }
    Object.defineProperties(root, {
      value: { configurable: true, get: () => raw(root) },
      selectionStart: { configurable: true, get: () => caretOffset(root) },
    });
    root.setSelectionRange = (start, end) => selectRange(root, start, end);
    if (composing.current || renderKey.current === key) return;
    const focused = document.activeElement === root;
    const offset = caretOffset(root);
    const nodes = parts.flatMap<Node>(part => {
      if (!part.label) return part.text.split('\n').flatMap((line, i) => i ? [document.createElement('br'), document.createTextNode(line)] : [document.createTextNode(line)]);
      const tag = document.createElement('span');
      tag.className = `chat-mention-tag chat-mention-${part.kind}`;
      tag.contentEditable = 'false';
      tag.dataset.token = part.text;
      if (part.kind === 'folder') {
        const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        icon.setAttribute('viewBox', '0 0 24 24');
        icon.setAttribute('width', '13'); icon.setAttribute('height', '13');
        icon.setAttribute('fill', 'none'); icon.setAttribute('stroke', 'currentColor');
        icon.setAttribute('stroke-width', '2'); icon.setAttribute('stroke-linecap', 'round'); icon.setAttribute('stroke-linejoin', 'round');
        icon.setAttribute('aria-hidden', 'true');
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'M20 20H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5l2 2h9a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2Z');
        icon.append(path); tag.append(icon, document.createTextNode(` ${part.label}`));
      } else tag.textContent = `${part.kind === 'agent' ? '◉' : '✦'} ${part.label}`;
      if (part.title) tag.title = part.title;
      tag.setAttribute('aria-label', `${part.kind === 'folder' ? 'Folder' : part.kind === 'agent' ? 'Agent' : 'Skill'}: ${part.title ?? part.label}`);
      return [tag];
    });
    if (value.endsWith('\n')) {
      const sentinel = document.createElement('br');
      sentinel.dataset.sentinel = 'true'; nodes.push(sentinel);
    }
    root.replaceChildren(...nodes);
    renderKey.current = key;
    if (focused) selectRange(root, Math.min(offset, value.length), Math.min(offset, value.length));
  }, [key, inputRef]);

  function insert(text: string) {
    const root = local.current!;
    const selection = window.getSelection();
    if (!selection?.rangeCount) return;
    const range = selection.getRangeAt(0);
    range.deleteContents();
    const node = text === '\n' ? document.createElement('br') : document.createTextNode(text);
    range.insertNode(node); range.setStartAfter(node); range.collapse(true);
    selection.removeAllRanges(); selection.addRange(range);
    onChange(raw(root)); onCaret();
  }

  return <div {...props} ref={local} role="textbox" aria-multiline="true" contentEditable
    data-placeholder={placeholder} aria-placeholder={placeholder}
    onInput={() => { if (!composing.current) onChange(raw(local.current!)); onCaret(); }}
    onCompositionStart={() => { composing.current = true; }}
    onCompositionEnd={() => { composing.current = false; renderKey.current = ''; onChange(raw(local.current!)); onCaret(); }}
    onPaste={event => { event.preventDefault(); insert(event.clipboardData?.getData('text/plain') ?? ''); }}
    onCopy={event => {
      const selection = window.getSelection();
      if (!selection?.rangeCount) return;
      event.preventDefault(); event.clipboardData?.setData('text/plain', raw(selection.getRangeAt(0).cloneContents()));
    }}
    onCut={event => {
      const selection = window.getSelection();
      if (!selection?.rangeCount) return;
      event.preventDefault();
      event.clipboardData?.setData('text/plain', raw(selection.getRangeAt(0).cloneContents()));
      insert('');
    }}
    onKeyDown={event => {
      if (!event.isComposing && (event.metaKey || event.ctrlKey) && !event.altKey && ['z', 'y'].includes(event.key.toLowerCase())) {
        event.preventDefault();
        const redo = event.shiftKey || event.key.toLowerCase() === 'y';
        const next = Math.max(0, Math.min(history.current.length - 1, historyIndex.current + (redo ? 1 : -1)));
        historyIndex.current = next;
        const restored = history.current[next];
        onChange(restored);
        requestAnimationFrame(() => { local.current?.setSelectionRange(restored.length, restored.length); onCaret(); });
        return;
      }
      if (event.key === 'Enter' && event.shiftKey && !event.isComposing) { event.preventDefault(); insert('\n'); return; }
      props.onKeyDown?.(event);
    }} />;
}
