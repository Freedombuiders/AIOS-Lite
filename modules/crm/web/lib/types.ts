// DTOs of GET /api/m/crm/* (see modules/crm/server/views.ts) and the few care shapes the screens write through.
import type { CustomerDetailDto, CustomerRowDto } from '@modules/crm/server/views';

export type { CustomerDetailDto, CustomerRowDto };
export type Stage = CustomerRowDto['giaiDoan'];

export interface CrmStatus {
  /** chua-cau-hinh | thieu-care | dang-chay | loi | san-sang */
  state: string;
  message: string;
  folderId?: string;
  exported?: number;
}

export interface BrainFolderLite {
  id: string;
  name: string;
  /** absolute path on disk */
  path: string;
}

/** the part of care's customer detail the profile needs: tasks to act on and the chat to open */
export interface CareCustomerLite {
  id: string;
  revision: number;
  conversations: Array<{ id: string; title: string; channel: string; primaryCustomerId: string | null; lastActivityMs: number }>;
  tasks: Array<{ id: string; title: string; dueAtMs: number; done: boolean; revision: number }>;
}

/** Everything the three screens ask of the server. Tests pass a fake. */
export interface CrmApi {
  status(): Promise<CrmStatus>;
  /** every customer (all pages) */
  customers(): Promise<CustomerRowDto[]>;
  customer(id: string): Promise<CustomerDetailDto>;
  /** care's own customer record: revision, conversations and tasks (with revisions) */
  careCustomer(id: string): Promise<CareCustomerLite>;
  /** the actual markdown of a note, read through the existing GET /api/brain/file */
  noteFile(folderId: string, path: string): Promise<{ content: string }>;
  brainFolders(): Promise<BrainFolderLite[]>;
  /** care's owner-only customer update (PUT /conversations/:id/customer-care); the note follows through the exporter */
  changeStage(customerId: string, stage: Stage): Promise<void>;
  /** care's PATCH /tasks/:id */
  patchTask(taskId: string, body: { expectedRevision: number; done?: boolean; dueAtMs?: number }): Promise<void>;
}
