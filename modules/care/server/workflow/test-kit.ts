/**
 * Test doubles for the workflow tests: small message helpers. Not imported by production code.
 */

import type { CareAccountRecord } from '../../../_lib/care-kit/types.js';
import type { CareStores } from '../persistence/index.js';
import { chatMessage } from '../test-fixtures.js';

let n = 0;

/** Appends one message to an existing seeded conversation (seedChat returns the conversation record). */
export function addMessage(stores: CareStores, account: CareAccountRecord, convId: string, key: string, dir: 'in' | 'out', at: number, text = 'hi'): void {
  n += 1;
  stores.messages.insertMessage(
    chatMessage(account, {
      externalConversationKey: key,
      nativeMessageId: `${key}-x${n}`,
      direction: dir,
      senderRole: dir === 'in' ? 'customer' : 'operator',
      sentAtMs: at,
      text,
    }),
    convId,
  );
  stores.conversations.recomputeProjection(convId);
}
