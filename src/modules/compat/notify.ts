import { getDeps } from './state.js';

/** Tell the owner something needs attention (appears in "Cần tôi" / attention list). */
export function notifyOwner(input: { key: string; title: string; detail?: string; link?: string; severity?: 'info' | 'warn' | 'error'; moduleId?: string }): void {
  getDeps().attention.raise({
    key: input.key.startsWith('module:') ? input.key : `module:${input.moduleId ?? 'compat'}:${input.key}`,
    kind: 'module',
    moduleId: input.moduleId,
    title: input.title,
    detail: input.detail,
    link: input.link,
    severity: input.severity ?? 'info',
  });
}
