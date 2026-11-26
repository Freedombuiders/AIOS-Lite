-- D2 · a durable feed of "this post note got (or changed) the numbers of a milestone", for other modules (dream's
-- comparison). Written right after the note write; readers keep their own cursor and call postNotes.events(cursor).
CREATE TABLE IF NOT EXISTS learn_note_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  folder_id  TEXT NOT NULL,
  rel_path   TEXT NOT NULL,
  content_id INTEGER NOT NULL,
  milestone  TEXT NOT NULL,
  er         REAL,
  at         INTEGER NOT NULL
);
