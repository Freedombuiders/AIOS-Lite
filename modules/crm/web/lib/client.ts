import { apiGet, apiPatch, apiPut, qs } from '@/lib/api';
import type { BrainFolderLite, CareCustomerLite, CrmApi, CrmStatus, CustomerDetailDto, CustomerRowDto, Stage } from './types';

export const CRM_API_BASE = '/api/m/crm';
const CARE = '/api/m/care';
const seg = encodeURIComponent;
const MAX_PAGES = 20;

export const crmApi: CrmApi = {
  status: () => apiGet<CrmStatus>(`${CRM_API_BASE}/status`),

  async customers() {
    const all: CustomerRowDto[] = [];
    let after: string | null = null;
    for (let i = 0; i < MAX_PAGES; i += 1) {
      const page: { items: CustomerRowDto[]; next: string | null } = await apiGet(`${CRM_API_BASE}/customers${qs({ limit: 200, after })}`);
      all.push(...page.items);
      after = page.next;
      if (!after) break;
    }
    return all;
  },

  customer: (id) => apiGet<CustomerDetailDto>(`${CRM_API_BASE}/customers/${seg(id)}`),
  careCustomer: (id) => apiGet<CareCustomerLite>(`${CARE}/customers/${seg(id)}`),
  noteFile: (folderId, path) => apiGet<{ content: string }>(`/api/brain/file${qs({ folder: folderId, path })}`),
  brainFolders: async () => (await apiGet<{ items: BrainFolderLite[] }>('/api/brain/folders')).items,

  async changeStage(customerId: string, stage: Stage) {
    const c = await crmApi.careCustomer(customerId);
    // the form route is per conversation: use one whose primary customer is this customer
    const conv = c.conversations.find((x) => x.primaryCustomerId === customerId);
    if (!conv) throw new Error('Khách này chưa có cuộc trò chuyện nên chưa đổi giai đoạn ở đây được. Mở hồ sơ trong Chăm sóc khách hàng.');
    await apiPut(`${CARE}/conversations/${seg(conv.id)}/customer-care`, { expectedCustomerRevision: c.revision, customer: { stage } });
  },

  async patchTask(taskId, body) {
    await apiPatch(`${CARE}/tasks/${seg(taskId)}`, body);
  },
};
