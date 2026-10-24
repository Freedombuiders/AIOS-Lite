import { radarDb } from './store.js';

/** Pain rows and the report-day counter of the first pain, for assertions. */
export function ledgerCounts(): { pains: number; painTimes: number } {
  const db = radarDb();
  const pains = (db.prepare('SELECT COUNT(*) AS n FROM radar_pains').get() as { n: number }).n;
  const first = db.prepare('SELECT times FROM radar_pains ORDER BY id LIMIT 1').get() as { times: number } | undefined;
  return { pains, painTimes: first?.times ?? 0 };
}
