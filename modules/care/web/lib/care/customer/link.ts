// Identity link / unlink: turns the preview into the request, and 409 UNDECIDED_ITEMS into a
// per-item resolution UI state. Pure: the page owns fetching.

import type { CareLinkPreviewDto } from '@modules/care/server/api/dto-ops';

export const LINK_FIELDS = ['displayName', 'company', 'phone', 'email', 'stage', 'tags', 'owner'] as const;
export type LinkField = (typeof LINK_FIELDS)[number];

/** Mirrors the API: keep the target's value, take another customer's, or type a customer-wide value. */
export type Resolution = { keep: 'target' } | { fromCustomerId: string } | { value: string | null };

export type ResolutionChoice =
  | { mode: 'target' }
  | { mode: 'customer'; customerId: string }
  | { mode: 'custom'; value: string };

export function toResolution(c: ResolutionChoice): Resolution {
  if (c.mode === 'target') return { keep: 'target' };
  if (c.mode === 'customer') return { fromCustomerId: c.customerId };
  const v = c.value.trim();
  return { value: v === '' ? null : v };
}

export interface LinkChoices {
  fields: Partial<Record<string, ResolutionChoice>>;
  /** Operator's explicit "keep the target's value for everything I did not decide". */
  keepTargetForUnresolved: boolean;
}

export function emptyChoices(): LinkChoices {
  return { fields: {}, keepTargetForUnresolved: false };
}

/** Fields that still need an explicit choice before the link can be sent. */
export function unresolvedFields(preview: CareLinkPreviewDto, choices: LinkChoices): string[] {
  if (choices.keepTargetForUnresolved) return [];
  return preview.conflicts.map((c) => c.field).filter((f) => choices.fields[f] === undefined);
}

export function canLink(preview: CareLinkPreviewDto, choices: LinkChoices): boolean {
  return !preview.noop && unresolvedFields(preview, choices).length === 0;
}

export interface LinkRequestBody {
  identityIds?: string[];
  customerIds?: string[];
  targetCustomerId: string;
  expectedRevisions: Record<string, number>;
  resolutions?: Partial<Record<LinkField, Resolution>>;
  keepTargetForUnresolved?: boolean;
  requestId?: string;
}

export function buildLinkBody(
  selection: { identityIds?: string[]; customerIds?: string[] },
  preview: CareLinkPreviewDto,
  choices: LinkChoices,
  requestId: string,
): LinkRequestBody {
  const resolutions: Partial<Record<LinkField, Resolution>> = {};
  for (const c of preview.conflicts) {
    const choice = choices.fields[c.field];
    if (choice && (LINK_FIELDS as readonly string[]).includes(c.field)) resolutions[c.field as LinkField] = toResolution(choice);
  }
  return {
    ...(selection.identityIds?.length ? { identityIds: selection.identityIds } : {}),
    ...(selection.customerIds?.length ? { customerIds: selection.customerIds } : {}),
    targetCustomerId: preview.targetCustomerId,
    expectedRevisions: preview.expectedRevisions,
    ...(Object.keys(resolutions).length ? { resolutions } : {}),
    ...(choices.keepTargetForUnresolved ? { keepTargetForUnresolved: true } : {}),
    requestId,
  };
}

/** Same request id while the payload is unchanged (a retry never double-applies); a changed payload gets a new one. */
export function requestIdFor(body: object, prev: { key: string; id: string } | null, gen: () => string): { key: string; id: string } {
  const key = JSON.stringify(body);
  return prev && prev.key === key ? prev : { key, id: gen() };
}

// ── undecided items (409 CONFIGURATION_CONFLICT / UNDECIDED_ITEMS) ────────────────────────────
export interface UndecidedItem {
  itemKey: string;
  type: 'task' | 'profile' | 'field' | string;
  id: string;
  accountId: string | null;
  candidateCustomerIds: string[];
}

export function undecidedFromDetails(details: Record<string, unknown> | undefined): UndecidedItem[] {
  if (!details || details.reason !== 'UNDECIDED_ITEMS' || !Array.isArray(details.items)) return [];
  return details.items.flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return [];
    const i = raw as Record<string, unknown>;
    if (typeof i.itemKey !== 'string' || typeof i.id !== 'string') return [];
    return [{
      itemKey: i.itemKey,
      type: typeof i.type === 'string' ? i.type : 'unknown',
      id: i.id,
      accountId: typeof i.accountId === 'string' ? i.accountId : null,
      candidateCustomerIds: Array.isArray(i.candidateCustomerIds) ? i.candidateCustomerIds.filter((x): x is string => typeof x === 'string') : [],
    }];
  });
}

/** Link-side undecided `field:<name>` items name the conflicting fields the preview showed. */
export function undecidedFieldNames(items: UndecidedItem[]): string[] {
  return items.filter((i) => i.type === 'field').map((i) => i.id);
}

export interface UnlinkDecisions {
  /** itemKey -> customer that keeps the item. */
  decisions: Record<string, string>;
}

export function unlinkReady(items: UndecidedItem[], decisions: Record<string, string>): boolean {
  return items.length > 0 && items.every((i) => i.candidateCustomerIds.includes(decisions[i.itemKey] ?? ''));
}

export interface UnlinkRequestBody {
  identityIds: string[];
  expectedRevisions: Record<string, number>;
  decisions?: Record<string, string>;
  requestId?: string;
}

export function buildUnlinkBody(identityIds: string[], expectedRevisions: Record<string, number>, decisions: Record<string, string>, requestId: string): UnlinkRequestBody {
  return { identityIds, expectedRevisions, ...(Object.keys(decisions).length ? { decisions } : {}), requestId };
}
