// Calls of the "Kênh & agent", Khách hàng and Công việc screens that lib/care/client.ts does not have.
// (Reads of /api/m/care/accounts, /assignments, /customers and PATCH /tasks/:id go through the existing `careApi`.)

import { apiFetch, apiGet, apiPost, apiPut } from '@/lib/api';
import { CARE_API_BASE } from '../care/client';
import type { CareCannedReplyDto } from '@modules/care/server/api/dto-inbox';
import type { CareTaskDto } from '@modules/care/server/api/dto';

const B = CARE_API_BASE;
const seg = encodeURIComponent;

export interface CannedBody {
  shortcut: string;
  title: string;
  body: string;
  emailBody: string | null;
  sort?: number;
}

export interface TaskQuery {
  done?: boolean;
  limit?: number;
  cursor?: string | null;
}

export const channelsApi = {
  // Câu trả lời nhanh
  canned: () => apiGet<{ items: CareCannedReplyDto[] }>(`${B}/canned`),
  createCanned: (body: CannedBody) => apiPost<CareCannedReplyDto>(`${B}/canned`, body),
  updateCanned: (id: string, body: CannedBody) => apiPut<CareCannedReplyDto>(`${B}/canned/${seg(id)}`, body),
  deleteCanned: async (id: string): Promise<void> => {
    await apiFetch(`${B}/canned/${seg(id)}`, { method: 'DELETE' });
  },

  // Công việc
  tasks: (q: TaskQuery = {}) => {
    const p = new URLSearchParams({ limit: String(q.limit ?? 200) });
    if (q.done !== undefined) p.set('done', String(q.done));
    if (q.cursor) p.set('cursor', q.cursor);
    return apiGet<{ items: CareTaskDto[]; nextCursor: string | null }>(`${B}/tasks?${p.toString()}`);
  },

};
