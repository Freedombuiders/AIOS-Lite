// Adapters: the only place that knows a backend's URLs and types. The shared form talks to
// `CustomerAdapter`; `careCoreAdapter` serves /api/m/care.

import type { CareCustomerCareDto } from '@modules/care/server/api/dto-ops';
import {
  splitNeed, STAGES, type CareSaveBody, type CustomerFormValue, type CustomerSnapshot, type Stage,
} from './model';

export interface AdapterCapabilities {
  /** Whether the backend stores an email on the customer. */
  email: boolean;
  /** `api`: tasks are created/updated immediately by id + revision. `none`: not editable in this adapter. */
  tasks: 'api' | 'none';
  /** Customer timeline + identity link/unlink exist (Care core only). */
  crossChannel: boolean;
}

export interface CustomerAdapter {
  id: 'care-core';
  capabilities: AdapterCapabilities;
  load(): Promise<CustomerSnapshot>;
  /** Persists `edited` relative to `snapshot`; resolves with the fresh server copy. */
  save(snapshot: CustomerSnapshot, edited: CustomerFormValue): Promise<CustomerSnapshot>;
}

// ── Care core ─────────────────────────────────────────────────────────────────────────────────
function isStage(s: string): s is Stage {
  return (STAGES as readonly string[]).includes(s);
}

export function snapshotFromCareDto(dto: CareCustomerCareDto): CustomerSnapshot {
  const { fields, extra } = splitNeed(dto.profile?.need ?? null);
  const c = dto.customer;
  return {
    customerId: c.id,
    value: {
      displayName: c.displayName,
      company: c.company ?? '',
      phone: c.phone ?? '',
      email: c.email ?? '',
      stage: isStage(c.stage) ? c.stage : 'new',
      tags: c.tags ?? '',
      owner: c.owner ?? '',
      need: fields,
      note: dto.profile?.note ?? '',
    },
    revisions: { customer: c.revision, profile: dto.profile ? dto.profile.revision : null },
    profileProvenance: dto.profile?.provenance ?? null,
    otherProfiles: dto.otherProfiles.map((p) => ({ id: p.id, provenance: p.provenance, accountId: p.accountId, note: p.note, need: p.need, revision: p.revision })),
    tasks: dto.tasks.map((t) => ({ id: t.id, title: t.title, dueAtMs: t.dueAtMs, done: t.done, owner: t.owner, revision: t.revision, conversationId: t.conversationId })),
    writeOwner: dto.writeOwner,
    writable: dto.writable,
    history: [],
    needExtra: extra,
  };
}

export interface CareCoreIo {
  get(): Promise<CareCustomerCareDto>;
  put(body: CareSaveBody): Promise<CareCustomerCareDto>;
}

export function careCoreAdapter(io: CareCoreIo, buildBody: (s: CustomerSnapshot, e: CustomerFormValue) => CareSaveBody | null): CustomerAdapter {
  return {
    id: 'care-core',
    capabilities: { email: true, tasks: 'api', crossChannel: true },
    load: async () => snapshotFromCareDto(await io.get()),
    async save(snapshot, edited) {
      const body = buildBody(snapshot, edited);
      if (!body) return snapshot;
      return snapshotFromCareDto(await io.put(body));
    },
  };
}
