import { NotebookPen } from 'lucide-preact';
import { PageHeader } from '@/components/PageHeader';
import { apiGet } from '@/lib/api';
import { useFetch } from '@/lib/useFetch';
import { defineWebModule, type WebNavItem } from '@/module-host/contracts';

// lucide's icon props accept string sizes, the host contract only numbers: cast once here
const icon = NotebookPen as unknown as WebNavItem['icon'];

interface Note {
  id: number;
  text: string;
  answer: string | null;
  created_at: string;
}

function NotesPage() {
  const { data, loading, error } = useFetch<{ items: Note[] }>('/api/m/_template/notes');
  return (
    <div>
      <PageHeader title="Ghi chú mẫu" breadcrumb="Module" />
      {loading && <p class="p-4 text-sm">Đang tải…</p>}
      {error && <p class="p-4 text-sm">Lỗi: {error}</p>}
      <ul class="p-4 space-y-2">
        {(data?.items ?? []).map((n) => (
          <li key={n.id} class="rounded border border-[var(--color-border)] p-3 text-sm">
            <div>{n.text}</div>
            {n.answer && <div class="mt-1 text-[var(--color-text-muted)]">{n.answer}</div>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function NotesWidget() {
  const { data } = useFetch<{ items: Note[] }>('/api/m/_template/notes');
  return <div class="text-sm">Ghi chú mẫu: {data?.items.length ?? 0}</div>;
}

export default defineWebModule({
  id: '_template',
  nav: [{ group: 'other', label: 'Ghi chú mẫu', path: '/m/_template', icon, badge: async () => (await apiGet<{ items: Note[] }>('/api/m/_template/notes')).items.length }],
  routes: [{ path: '/m/_template', component: NotesPage }],
  widgets: [{ slot: 'dashboard', id: 'template-notes', title: 'Ghi chú mẫu', component: NotesWidget }],
  agentAccess: [
    { scope: 'notes.read', label: 'Đọc ghi chú', description: 'Agent được xem ghi chú của module.' },
    { scope: 'notes.write', label: 'Tạo ghi chú', description: 'Agent được trả lời và lưu ghi chú.' },
  ],
});
