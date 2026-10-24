// Single import point for the host helpers KOL Studio needs.
import { getDb } from '../../../src/modules/compat/index.js';

export {
  logger, getDb, _initTestDatabase, moduleCompat, bindModuleCompat, unbindModuleCompat, readEnvFile,
  isEnabled, requireEnabled, KillSwitchDisabledError, _reset, _setOverride,
} from '../../../src/modules/compat/index.js';

/** The shared application database (KOL tables live next to the core ones). */
export const getApplicationDb = getDb;
