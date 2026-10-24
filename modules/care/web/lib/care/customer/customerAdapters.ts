// Network wiring of the Care core adapter (the only Customer 360 backend the Care pages use).

import { apiGet, apiPut } from '@/lib/api';
import type { CareCustomerCareDto } from '@modules/care/server/api/dto-ops';
import { careCoreAdapter, type CustomerAdapter } from './adapters';
import { buildSaveBody } from './model';

export function careCoreAdapterFor(conversationId: string, participantIdentityId?: string | null): CustomerAdapter {
  const url = `/api/m/care/conversations/${encodeURIComponent(conversationId)}/customer-care${participantIdentityId ? `?participant=${encodeURIComponent(participantIdentityId)}` : ''}`;
  return careCoreAdapter(
    { get: () => apiGet<CareCustomerCareDto>(url), put: (body) => apiPut<CareCustomerCareDto>(url, body) },
    buildSaveBody,
  );
}
