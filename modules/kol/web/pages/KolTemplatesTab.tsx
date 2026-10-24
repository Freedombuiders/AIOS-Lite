/** KOL Studio › Mẫu tái tạo: reference photos for composition, pose and light. */
import { useMemo, useState } from 'preact/hooks';
import { Info, LayoutTemplate } from 'lucide-preact';
import { PageState } from '@/components/PageState';
import { FilterChip } from '@modules/kol/web/components/shared/ops-shared';
import { TEMPLATE_NOTICE, TemplateCard, TemplateEditor, TemplateUploadButtons, uploadTemplates } from '@modules/kol/web/components/templates';
import { DropZone, EmptyHint } from '@modules/kol/web/components/ui';
import { useFetch } from '@/lib/useFetch';
import { KOL, templateGroups, type TemplateDto } from '@modules/kol/web/lib/kol';

export function KolTemplatesTab() {
  const list = useFetch<{ templates: TemplateDto[] }>(KOL.templates);
  const [filter, setFilter] = useState<'all' | 'single' | 'carousel'>('all');
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const groups = useMemo(() => templateGroups(list.data?.templates ?? []), [list.data]);
  const shown = groups.filter((g) => filter === 'all' || g.kind === filter);
  const editingGroup = groups.find((g) => g.key === editing) ?? null;

  async function drop(files: File[]) {
    setBusy(true);
    await uploadTemplates(files, 'single');
    setBusy(false);
    list.refresh();
  }

  return (
    <div class="flex-1 min-h-0 overflow-y-auto px-4 md:px-6 py-4 flex flex-col gap-3">
      <div role="note" class="flex items-start gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] px-3.5 py-2.5 text-[12.5px] text-[var(--color-text)]">
        <Info size={15} class="shrink-0 mt-0.5 text-[var(--color-accent)]" aria-hidden="true" />
        <span>{TEMPLATE_NOTICE}</span>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Lọc mẫu" class="flex flex-wrap gap-1.5">
          <FilterChip on={filter === 'all'} label="Tất cả" count={groups.length} onClick={() => setFilter('all')} />
          <FilterChip on={filter === 'single'} label="Ảnh đơn" count={groups.filter((g) => g.kind === 'single').length} onClick={() => setFilter('single')} />
          <FilterChip on={filter === 'carousel'} label="Carousel" count={groups.filter((g) => g.kind === 'carousel').length} onClick={() => setFilter('carousel')} />
        </div>
        <div class="ml-auto"><TemplateUploadButtons onDone={list.refresh} /></div>
      </div>

      {!list.data && <PageState loading={list.loading} error={list.error} />}
      {list.data && groups.length === 0 && (
        <EmptyHint icon={<LayoutTemplate size={20} />} title="Chưa có mẫu nào">
          Tải ảnh có bố cục, dáng hoặc ánh sáng bạn thích (ảnh Pinterest, ảnh chụp màn hình bài viral…). Trong Studio, chọn mẫu để KOL “đóng” lại khung hình đó với khuôn mặt của mình.
          Bộ carousel: chọn nhiều ảnh cùng lúc, thứ tự theo tên file.
        </EmptyHint>
      )}
      {list.data && (
        <DropZone multiple disabled={busy} onFiles={(f) => { void drop(f); }}>
          <span>{busy ? 'Đang tải…' : 'Kéo thả ảnh vào đây để thêm nhanh (mỗi ảnh một mẫu đơn)'}</span>
        </DropZone>
      )}
      {shown.length > 0 && (
        <ul class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 2xl:grid-cols-7 gap-2.5 list-none m-0 p-0">
          {shown.map((g) => <li key={g.key} class="min-w-0"><TemplateCard group={g} onClick={() => setEditing(g.key)} /></li>)}
        </ul>
      )}
      {editingGroup && <TemplateEditor key={editingGroup.key} group={editingGroup} onClose={() => setEditing(null)} onChanged={list.refresh} />}
    </div>
  );
}
