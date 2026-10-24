// Data the v2 inbox loads next to the conversation: agents (assignee menu), canned replies, internal
// notes and pending AI drafts. Every one of them is optional: a failed or missing route degrades to "empty", it never
// blocks reading or replying.

import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { apiGet } from '@/lib/api';
import { careApi } from './client';
import { newRequestId } from './composer';
import type { CareCannedReplyDto, CareInlineDraftDto, CareNoteDto } from './dto';
import { pendingDrafts, validDraft, validNote } from './inlineDrafts';

// ── agents ────────────────────────────────────────────────────────────────────────────────────
export interface AgentLite { id: string; name: string }

let agentsCache: AgentLite[] | null = null;
let agentsInflight: Promise<AgentLite[]> | null = null;

function loadAgents(): Promise<AgentLite[]> {
  if (agentsCache) return Promise.resolve(agentsCache);
  agentsInflight = agentsInflight ?? apiGet<{ agents?: Array<{ id: string; name?: string }> }>('/api/agents')
    .then((r) => {
      agentsCache = (r.agents ?? []).filter((a) => a && typeof a.id === 'string' && a.id !== 'main').map((a) => ({ id: a.id, name: a.name || a.id }));
      return agentsCache;
    })
    .catch(() => [] as AgentLite[])
    .finally(() => { agentsInflight = null; });
  return agentsInflight;
}

/** Agents that can be assigned a conversation (the main agent is not one). */
export function useAgents(): AgentLite[] {
  const [agents, setAgents] = useState<AgentLite[]>(agentsCache ?? []);
  useEffect(() => {
    let live = true;
    void loadAgents().then((a) => { if (live) setAgents(a); });
    return () => { live = false; };
  }, []);
  return agents;
}

export function agentName(agents: AgentLite[], id: string | null | undefined): string {
  if (!id) return '';
  return agents.find((a) => a.id === id)?.name ?? id;
}

// ── canned replies ────────────────────────────────────────────────────────────────────────────
export function useCanned(): CareCannedReplyDto[] {
  const [items, setItems] = useState<CareCannedReplyDto[]>([]);
  useEffect(() => {
    let live = true;
    careApi.canned().then((r) => { if (live && Array.isArray(r.items)) setItems(r.items); }).catch(() => undefined);
    return () => { live = false; };
  }, []);
  return items;
}

// ── notes + drafts of one conversation ────────────────────────────────────────────────────────
export function useConversationExtras(conversationId: string, convTick: number, resyncTick: number) {
  const [notes, setNotes] = useState<CareNoteDto[]>([]);
  const [drafts, setDrafts] = useState<CareInlineDraftDto[]>([]);
  const seq = useRef(0);

  const reloadNotes = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const r = await careApi.notes(conversationId);
      if (mine === seq.current && Array.isArray(r.items)) setNotes(r.items.filter(validNote));
    } catch { /* notes are optional */ }
  }, [conversationId]);

  const reloadDrafts = useCallback(async () => {
    try {
      const r = await careApi.conversationDrafts(conversationId);
      if (Array.isArray(r.items)) setDrafts(pendingDrafts(r.items.filter(validDraft)));
    } catch { setDrafts([]); }
  }, [conversationId]);

  // Open / switch conversation, and every stream tick for it (workflow, notes and drafts changes ride `conversation.updated`).
  useEffect(() => { void reloadNotes(); void reloadDrafts(); }, [conversationId, convTick, resyncTick, reloadNotes, reloadDrafts]);

  const addNote = useCallback(async (body: string, clientRequestId: string): Promise<CareNoteDto> => {
    const note = await careApi.addNote(conversationId, body, clientRequestId);
    if (note && typeof note.id === 'string') setNotes((cur) => (cur.some((n) => n.id === note.id) ? cur : [...cur, note]));
    else await reloadNotes();
    return note;
  }, [conversationId, reloadNotes]);

  const removeNote = useCallback(async (noteId: string): Promise<void> => {
    await careApi.deleteNote(noteId);
    setNotes((cur) => cur.filter((n) => n.id !== noteId));
  }, []);

  return { notes, drafts, addNote, removeNote, reloadDrafts, reloadNotes };
}

// ── note drafts (survive switching conversation; never persisted) ─────────────────────────────
interface NoteDraft { text: string; requestId: string | null }
const noteDrafts = new Map<string, NoteDraft>();

export const noteDraftStore = {
  get: (id: string): NoteDraft => noteDrafts.get(id) ?? { text: '', requestId: null },
  /** Typing changes the payload, so the request id is minted again (one id never covers two bodies). */
  setText(id: string, text: string): void { noteDrafts.set(id, { text, requestId: null }); },
  /** The id for the current text, minted once and reused when a lost response is retried. */
  requestId(id: string): string {
    const cur = noteDrafts.get(id) ?? { text: '', requestId: null };
    const requestId = cur.requestId ?? newRequestId();
    noteDrafts.set(id, { ...cur, requestId });
    return requestId;
  },
  clear(id: string): void { noteDrafts.delete(id); },
};
