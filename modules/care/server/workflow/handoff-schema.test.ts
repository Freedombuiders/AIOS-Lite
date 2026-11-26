import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { ensureWorkflowSchema } from './schema.js';
import { ensureHandoffSchema } from './handoff-schema.js';

describe('handoff columns migration (T06)', () => {
  it('adds the columns to an existing care_conversation_state, keeps its rows, and is idempotent', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE care_conversations (id TEXT PRIMARY KEY)');
    db.prepare("INSERT INTO care_conversations (id) VALUES ('c1')").run();
    ensureWorkflowSchema(db); // the layout before T06
    db.prepare("INSERT INTO care_conversation_state (conversation_id, taken_over_at, updated_at) VALUES ('c1', 5, 5)").run();

    ensureHandoffSchema(db);
    ensureHandoffSchema(db);
    const cols = (db.prepare('PRAGMA table_info(care_conversation_state)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['handoff_at', 'handoff_keyword', 'handoff_message_id']));
    expect(db.prepare("SELECT taken_over_at, handoff_at FROM care_conversation_state WHERE conversation_id = 'c1'").get()).toEqual({ taken_over_at: 5, handoff_at: null });
    db.close();
  });
});
