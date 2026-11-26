import type { Env } from './env';
import type { SessionRow, UserRow } from './db/users';

export interface AuthContext {
  user: UserRow;
  session: SessionRow;
}

/** Hono generics: the platform `Env` arrives as Bindings; auth is set by requireSession. */
export interface AppEnv {
  Bindings: Env;
  Variables: { auth: AuthContext };
}
