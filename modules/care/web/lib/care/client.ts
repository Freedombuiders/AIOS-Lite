// Thin typed wrappers over /api/m/care. All paths and shapes come from the server DTO contract.

import { apiDelete, apiFetch, apiGet, apiPatch, apiPost, apiPut } from '@/lib/api';
import type {
  CareAssignmentDto, CareActivityItemDto, CareDraftDto, CareDraftRequestDto, CareEffectiveRuleDto, CareHoldDto,
  CareLinkPreviewDto, CareLinkResultDto, CareSwitchDto, CareTimelinePageDto, CareUnlinkResultDto,
} from '@modules/care/server/api/dto-ops';
import type { DraftPatchBody } from './draftReview';
import type { LinkRequestBody, UnlinkRequestBody } from './customer/link';
import type { RuleBody } from './rules';
import type {
  CareAccountDto, CareCannedReplyDto, CareInlineDraftDto, CareNoteDto, CareCustomerDetailDto, CareCustomerDto, CareTaskDto, CareConversationDto, CareConversationListDto, CareMessagePageDto, CareOutboxIntentDto,
  CareReplyAcceptedDto, CareSearchResultDto, CareStatusDto,
} from './dto';
import type { ReplyBody } from './composer';

/** The ONE place that knows the module API prefix. */
export const CARE_API_BASE = '/api/m/care';
const B = CARE_API_BASE;
const seg = encodeURIComponent;

/** POST whose success body may be empty or not JSON (the legacy draft approve/discard answer with whatever the old module returned). */
async function postLoose(path: string, body: unknown): Promise<unknown> {
  const res = await apiFetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text().catch(() => '');
  if (!text) return null;
  try { return JSON.parse(text) as unknown; } catch { return null; }
}

export type WorkflowAction = { action: 'done' | 'reopen' } | { action: 'snooze'; snoozeUntilMs: number };
export type AssigneeChoice = { kind: 'owner' | 'none' | 'default' } | { kind: 'agent'; agentId: string };

export const careApi = {
  status: () => apiGet<CareStatusDto>(`${B}/status`),
  accounts: () => apiGet<{ items: CareAccountDto[] }>(`${B}/accounts`),
  conversations: (query: string) => apiGet<CareConversationListDto>(`${B}/conversations?${query}`),
  conversation: (id: string) => apiGet<CareConversationDto>(`${B}/conversations/${seg(id)}`),
  messages: (id: string, params: { before?: string; after?: string; around?: string; limit?: number } = {}) => {
    const p = new URLSearchParams();
    if (params.before) p.set('before', params.before);
    if (params.after) p.set('after', params.after);
    if (params.around) p.set('around', params.around);
    p.set('limit', String(params.limit ?? 40));
    return apiGet<CareMessagePageDto>(`${B}/conversations/${seg(id)}/messages?${p.toString()}`);
  },
  markRead: (id: string, messageId?: string) => apiPost<CareConversationDto>(`${B}/conversations/${seg(id)}/read`, messageId ? { messageId } : {}),
  search: (query: string) => apiGet<CareSearchResultDto>(`${B}/search?${query}`),
  reply: (id: string, body: ReplyBody) => apiPost<CareReplyAcceptedDto>(`${B}/conversations/${seg(id)}/replies`, body),
  outbox: (id: string) => apiGet<CareOutboxIntentDto>(`${B}/outbox/${seg(id)}`),
  cancel: (id: string) => apiPost<CareOutboxIntentDto>(`${B}/outbox/${seg(id)}/cancel`, {}),
  reconcile: (id: string) => apiPost<CareOutboxIntentDto>(`${B}/outbox/${seg(id)}/reconcile`, {}),

  // shared inbox v2: workflow, assignee, AI mode, notes, canned replies, prefs
  setWorkflow: (id: string, body: WorkflowAction & { expectedStateRevision?: number }) => apiPut<CareConversationDto>(`${B}/conversations/${seg(id)}/workflow`, body),
  setAssignee: (id: string, body: AssigneeChoice) => apiPut<CareConversationDto>(`${B}/conversations/${seg(id)}/assignee`, body),
  setAiMode: (id: string, mode: 'off' | 'draft' | 'auto') => apiPut<CareConversationDto>(`${B}/conversations/${seg(id)}/ai`, { mode }),
  setTakeover: (id: string, on: boolean) => apiPut<CareConversationDto>(`${B}/conversations/${seg(id)}/takeover`, { on }),
  notes: (id: string) => apiGet<{ items: CareNoteDto[] }>(`${B}/conversations/${seg(id)}/notes`),
  addNote: (id: string, body: string, clientRequestId: string) => apiPost<CareNoteDto>(`${B}/conversations/${seg(id)}/notes`, { body, clientRequestId }),
  deleteNote: (noteId: string) => apiDelete<unknown>(`${B}/notes/${seg(noteId)}`),
  canned: () => apiGet<{ items: CareCannedReplyDto[] }>(`${B}/canned`),
  conversationDrafts: (id: string) => apiGet<{ items: CareInlineDraftDto[] }>(`${B}/conversations/${seg(id)}/drafts`),
  inlineDrafts: (limit = 100) => apiGet<{ items: CareInlineDraftDto[] }>(`${B}/inline-drafts?limit=${limit}`),
  /** Inline drafts take an optional edited text; the answer body is not relied on. */
  approveInline: (id: string, text?: string) => postLoose(`${B}/drafts/${seg(id)}/approve`, text !== undefined ? { text } : {}),
  discardInline: (id: string) => postLoose(`${B}/drafts/${seg(id)}/discard`, {}),

  // customers, tasks, identities
  customers: (query: string) => apiGet<{ items: CareCustomerDto[]; nextCursor: string | null }>(`${B}/customers?${query}`),
  customer: (id: string) => apiGet<CareCustomerDetailDto>(`${B}/customers/${seg(id)}`),
  timeline: (id: string, cursor?: string | null) => apiGet<CareTimelinePageDto>(`${B}/customers/${seg(id)}/timeline?limit=30${cursor ? `&cursor=${seg(cursor)}` : ''}`),
  previewLink: (body: { identityIds?: string[]; customerIds?: string[]; targetCustomerId?: string }) => apiPost<CareLinkPreviewDto>(`${B}/identities/preview-link`, body),
  link: (body: LinkRequestBody) => apiPost<CareLinkResultDto>(`${B}/identities/link`, body),
  unlink: (body: UnlinkRequestBody) => apiPost<CareUnlinkResultDto>(`${B}/identities/unlink`, body),
  createTask: (body: { customerId: string; conversationId?: string | null; title: string; dueAtMs: number }) => apiPost<CareTaskDto>(`${B}/tasks`, body),
  patchTask: (id: string, body: { expectedRevision: number; done?: boolean; title?: string; dueAtMs?: number }) => apiPatch<CareTaskDto>(`${B}/tasks/${seg(id)}`, body),

  // rules
  assignments: () => apiGet<{ items: CareAssignmentDto[] }>(`${B}/assignments`),
  saveRule: (id: string | null, body: RuleBody) => (id ? apiPut<CareAssignmentDto | { ok: true; dryRun: true }>(`${B}/assignments/${seg(id)}`, body) : apiPost<CareAssignmentDto | { ok: true; dryRun: true }>(`${B}/assignments`, body)),
  deleteRule: (id: string, expectedConfigVersion: number) => apiDelete<{ ok: true }>(`${B}/assignments/${seg(id)}?expectedConfigVersion=${expectedConfigVersion}`),
  effectiveRule: (conversationId: string) => apiGet<CareEffectiveRuleDto>(`${B}/conversations/${seg(conversationId)}/effective-rule`),

  // drafts / activity
  requestDraft: (conversationId: string, clientRequestId: string) => apiPost<CareDraftRequestDto>(`${B}/conversations/${seg(conversationId)}/draft`, { clientRequestId }),
  drafts: (statuses: readonly string[]) => apiGet<{ items: CareDraftDto[] }>(`${B}/drafts?status=${statuses.join(',')}&limit=100`),
  editDraft: (id: string, body: DraftPatchBody) => apiPatch<CareDraftDto>(`${B}/drafts/${seg(id)}`, body),
  approveDraft: (id: string, expectedRevision: number, currentContextRevision?: number) => apiPost<CareDraftDto>(`${B}/drafts/${seg(id)}/approve`, { expectedRevision, ...(currentContextRevision !== undefined ? { currentContextRevision } : {}) }),
  discardDraft: (id: string) => apiPost<CareDraftDto>(`${B}/drafts/${seg(id)}/discard`, {}),
  activity: (params: { account?: string; conversation?: string; cursor?: string | null }) => {
    const p = new URLSearchParams({ limit: '40' });
    if (params.account) p.set('account', params.account);
    if (params.conversation) p.set('conversation', params.conversation);
    if (params.cursor) p.set('cursor', params.cursor);
    return apiGet<{ items: CareActivityItemDto[]; nextCursor: string | null }>(`${B}/activity?${p.toString()}`);
  },

  // runtime
  switches: () => apiGet<{ items: CareSwitchDto[] }>(`${B}/runtime/switches`),
  setSwitch: (key: string, enabled: boolean, reason: string) => apiPut<{ key: string; enabled: boolean; held: number }>(`${B}/runtime/switches`, { key, enabled, reason }),
  holds: () => apiGet<{ items: CareHoldDto[] }>(`${B}/runtime/holds`),
  releaseHold: (kind: string, id: string) => apiPost<{ released: boolean }>(`${B}/runtime/holds/${seg(kind)}/${seg(id)}/release`, {}),
  discardHold: (kind: string, id: string) => apiPost<{ discarded: boolean }>(`${B}/runtime/holds/${seg(kind)}/${seg(id)}/discard`, {}),

};

export const EVENTS_PATH = `${B}/events`;
