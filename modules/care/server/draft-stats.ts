// Read-only numbers about bot drafts, for other modules (learn's "nháp gửi nguyên" metric) through care's
// `provides`: other modules never query care's tables themselves.
//
// What the columns mean (persistence/outbox-store.ts):
// - every intent is inserted with payload_revision = 1; each edit (updatePayload) bumps it and drops the approval;
// - approve() sets approved_revision = payload_revision, so payload_revision = approved_revision only says that
//   the current text was approved, not that nobody changed it;
// - a draft the agent proposed has source_run_id set and actor 'approved' (auto replies are actor 'auto' and never
//   wait for review, so they are not drafts).
// So "sent unchanged" = bot draft, payload_revision = 1, status 'sent'. The denominator is every bot draft that
// has been decided: sent (edited or not), discarded, cancelled or failed after approval. Drafts still waiting are
// counted apart (`open`) and left out of the rate.
import type { DB } from '../../../src/core/db.js';

export interface DraftStatsRange {
  /** inclusive, epoch ms (by the draft's created_at) */
  fromMs: number;
  /** exclusive, epoch ms */
  toMs: number;
}

export interface DraftStats {
  /** bot drafts created in the range */
  botDrafts: number;
  /** sent with payload_revision = 1 */
  sentUnchanged: number;
  /** sent after at least one edit */
  sentEdited: number;
  /** discarded by the person */
  discarded: number;
  /** approved but cancelled, or failed to send */
  notDelivered: number;
  /** still a draft, waiting or being sent */
  open: number;
  /** sentUnchanged ÷ (sentUnchanged + sentEdited + discarded + notDelivered), null when nothing was decided */
  unchangedRate: number | null;
}

const OPEN = ['draft', 'pending', 'sending', 'retry_wait', 'uncertain', 'needs_review'];

export function draftStats(db: DB, range: DraftStatsRange): DraftStats {
  const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'care_delivery_intents'").get();
  const empty: DraftStats = { botDrafts: 0, sentUnchanged: 0, sentEdited: 0, discarded: 0, notDelivered: 0, open: 0, unchangedRate: null };
  if (!hasTable) return empty;
  const rows = db
    .prepare(
      `SELECT status, (payload_revision = 1) AS first, COUNT(*) AS n FROM care_delivery_intents
       WHERE source_run_id IS NOT NULL AND actor <> 'auto' AND purpose = 'care' AND created_at >= ? AND created_at < ?
       GROUP BY status, first`,
    )
    .all(range.fromMs, range.toMs) as Array<{ status: string; first: number; n: number }>;
  const out = { ...empty };
  for (const r of rows) {
    out.botDrafts += r.n;
    if (r.status === 'sent') {
      if (r.first === 1) out.sentUnchanged += r.n;
      else out.sentEdited += r.n;
    } else if (r.status === 'discarded') out.discarded += r.n;
    else if (OPEN.includes(r.status)) out.open += r.n;
    else out.notDelivered += r.n; // cancelled, failed
  }
  const decided = out.sentUnchanged + out.sentEdited + out.discarded + out.notDelivered;
  out.unchangedRate = decided ? out.sentUnchanged / decided : null;
  return out;
}
