import type { PackModule } from '../../../../packages/api-types/src/index';
import type { MessageKey } from '@/i18n';

/** Typed as a Record so a module added to the cloud's types fails to compile here until it has a label. */
export const MODULE_LABEL: Record<PackModule, MessageKey> = {
  brain: 'module.brain',
  learn: 'module.learn',
  dream: 'module.dream',
  crm: 'module.crm',
};

export const MODULES = Object.keys(MODULE_LABEL) as PackModule[];
