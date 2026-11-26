import type { AuthResponse } from '../../../packages/api-types/src/index';
import { session, user } from './fixtures';

export const auth = (token = 'tok_new'): AuthResponse => ({ token, user: user(), session: session() });
