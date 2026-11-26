/**
 * Migration (T06): the "customer asked for a person" marker on the care-only conversation state.
 *
 * A hard handoff (ingest.ts) is a TAKE-OVER (assignee owner, taken_over_at) plus a timed pause on the conversation row;
 * these columns only record WHY the owner holds the conversation, so the inbox and the attention sweep can say so and
 * the marker is cleared together with the take-over. No new table, additive and idempotent like the other extensions
 * (no CARE_SCHEMA_VERSION bump). Imports nothing but the DB type: persistence/schema.ts depends on it.
 *
 *   handoff_at          when the handoff was raised (epoch ms), NULL when none is open
 *   handoff_keyword     the CONFIGURED keyword that matched (owner text, never customer text)
 *   handoff_message_id  the local message that triggered it
 */

import type Database from 'better-sqlite3';

const COLUMNS: ReadonlyArray<[string, string]> = [
  ['handoff_at', 'INTEGER'],
  ['handoff_keyword', 'TEXT'],
  ['handoff_message_id', 'TEXT'],
];

export function ensureHandoffSchema(db: Database.Database): void {
  const have = new Set((db.prepare('PRAGMA table_info(care_conversation_state)').all() as Array<{ name: string }>).map((c) => c.name));
  for (const [name, ddl] of COLUMNS) {
    if (!have.has(name)) db.exec(`ALTER TABLE care_conversation_state ADD COLUMN ${name} ${ddl}`);
  }
}
