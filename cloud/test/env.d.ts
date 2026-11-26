import type { D1Migration } from '@cloudflare/vitest-plugin';
import type { WorkerBindings } from '../src/index';

declare global {
  namespace Cloudflare {
    interface Env extends WorkerBindings {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
