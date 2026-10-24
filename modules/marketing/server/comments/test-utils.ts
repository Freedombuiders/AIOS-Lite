/**
 * Fixtures shared by the comments tests (not a test file itself).
 */

import {
  insertFbCommentIfNew,
  updateFbPageFields,
  upsertFbPageFromSync,
  type FbCommentRow,
} from '../store.js';

export const NOW = 1_800_000_000; // fixed "current" second for fake clocks
export const PAGE_ID = 'P1';

export function seedPage(patch: { enabled?: boolean; brandVoice?: string; status?: string } = {}): void {
  upsertFbPageFromSync({
    id: PAGE_ID, name: 'Ninh Bình Home', connection_id: 'ca_1', entity_id: 'ent_1', picture_url: '', followers: null,
  });
  updateFbPageFields(PAGE_ID, {
    enabled: patch.enabled === false ? 0 : 1,
    ...(patch.brandVoice ? { brand_voice: patch.brandVoice } : {}),
  });
}

let seq = 0;

/** Inserts a customer comment in `new` state unless overridden. */
export function seedComment(patch: Partial<FbCommentRow> = {}): FbCommentRow {
  const n = ++seq;
  const row: FbCommentRow = {
    id: `P1_100_${n}`,
    page_id: PAGE_ID,
    post_id: 'P1_100',
    parent_id: null,
    author_id: `u${n}`,
    author_name: 'Lan',
    message: 'Cho mình hỏi khóa này bao lâu thì học xong vậy ạ',
    created_time: NOW - 60,
    fetched_at: NOW - 30,
    from_page: 0,
    step: '',
    rule_ref: '',
    reason: '',
    reply_text: '',
    private_text: '',
    status: 'new',
    send_after: null,
    reply_comment_id: null,
    private_sent: 0,
    attempts: 0,
    error: '',
    topic: '',
    decided_at: null,
    sent_at: null,
    action: '',
    ...patch,
  };
  insertFbCommentIfNew(row);
  return row;
}
