/** KOL Studio › Thư viện: outfits, expressions, hair, scenes, poses, looks, effects, camera setups. */
import { useMemo, useState } from 'preact/hooks';
import { Plus, Search } from 'lucide-preact';
import { PageState } from '@/components/PageState';
import { BTN_PRIMARY, FilterChip, INPUT } from '@modules/kol/web/components/shared/ops-shared';
import { GroupChips, LibraryItemEditor, LibraryTile, type LibraryEditorTarget } from '@modules/kol/web/components/library';
import { PreviewStudio } from '@modules/kol/web/components/previews';
import { EmptyHint } from '@modules/kol/web/components/ui';
import { invalidateFetchCache, useFetch } from '@/lib/useFetch';
import { useDebouncedValue } from '@/lib/useDebounce';
import {
  KOL, LIBRARY_GENDER_LABEL, LIBRARY_KINDS, LIBRARY_KIND_LABEL, filterLibrary, fitsGender,
  type LibraryItemDto, type LibraryKind, type PersonaSummaryDto,
} from '@modules/kol/web/lib/kol';

export function KolLibraryTab() {
  // Without a persona the server lists shared items only; picking a KOL adds that KOL's own items.
  const [scope, setScope] = useState('');
  // '' = every item; a gender keeps that gender's and everyone's items and shows the catalog photos in that version.
  const [gender, setGender] = useState<'' | 'female' | 'male'>('');
  const lib = useFetch<{ items: LibraryItemDto[] }>(KOL.library({ ...(scope ? { personaId: scope } : {}), ...(gender ? { gender } : {}) }));
  const personas = useFetch<{ personas: PersonaSummaryDto[] }>(KOL.personas);
  const [kind, setKind] = useState<LibraryKind>('outfit');
  const [group, setGroup] = useState('');
  const [query, setQuery] = useState('');
  const [editor, setEditor] = useState<{ key: number; target: LibraryEditorTarget } | null>(null);
  const dq = useDebouncedValue(query, 200);

  const all = lib.data?.items ?? [];
  const ofKind = useMemo(() => all.filter((i) => i.kind === kind && fitsGender(i, gender || null)), [all, kind, gender]);
  const shown = useMemo(() => filterLibrary(ofKind, group, dq), [ofKind, group, dq]);
  const groups = useMemo(() => [...new Set(ofKind.map((i) => i.group).filter(Boolean))], [ofKind]);
  const personaNames = useMemo(() => new Map((personas.data?.personas ?? []).map((p) => [p.id, p.name])), [personas.data]);
  // With a KOL in scope the photo panel draws that KOL's own set.
  const scopePersona = scope && personaNames.has(scope) ? { id: scope, name: personaNames.get(scope)! } : null;
  const count = (k: LibraryKind) => all.filter((i) => i.kind === k && fitsGender(i, gender || null)).length;

  function open(target: LibraryEditorTarget) {
    setEditor({ key: Date.now(), target });
  }

  return (
    <div class="flex-1 min-h-0 overflow-y-auto px-4 md:px-6 py-4 flex flex-col gap-3">
      <p class="text-[12.5px] text-[var(--color-text-muted)] max-w-[820px]">
        Mỗi mục là một đoạn prompt tiếng Anh (kèm ảnh tham chiếu nếu có) bạn chọn trong Studio: trang phục, biểu cảm, kiểu tóc, bối cảnh… Mục có sẵn dùng chung cho mọi KOL; mục “Riêng” chỉ hiện với một KOL.
      </p>
      <PreviewStudio onChanged={lib.refresh} persona={scopePersona} />
      <div role="group" aria-label="Loại" class="flex flex-wrap gap-1.5">
        {LIBRARY_KINDS.map((k) => (
          <FilterChip key={k} on={kind === k} label={LIBRARY_KIND_LABEL[k]} count={lib.data ? count(k) : undefined} onClick={() => { setKind(k); setGroup(''); }} />
        ))}
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <label class="relative flex-1 min-w-[180px] max-w-[360px]">
          <Search size={14} class="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-faint)]" aria-hidden="true" />
          <input class={`${INPUT} w-full pl-8`} type="search" aria-label="Tìm trong thư viện" placeholder={`Tìm ${LIBRARY_KIND_LABEL[kind].toLowerCase()}…`} value={query} onInput={(e) => setQuery((e.target as HTMLInputElement).value)} />
        </label>
        <select class={`${INPUT} w-auto`} aria-label="Dành cho" value={gender} onChange={(e) => { setGender((e.target as HTMLSelectElement).value as '' | 'female' | 'male'); setGroup(''); }}>
          <option value="">Nữ + Nam</option>
          <option value="female">Cho KOL nữ</option>
          <option value="male">Cho KOL nam</option>
        </select>
        <select class={`${INPUT} w-auto`} aria-label="Phạm vi" value={scope} onChange={(e) => { setScope((e.target as HTMLSelectElement).value); setGroup(''); }}>
          <option value="">Mục dùng chung</option>
          {(personas.data?.personas ?? []).filter((p) => p.status !== 'archived').map((p) => <option key={p.id} value={p.id}>Dùng chung + riêng của {p.name}</option>)}
        </select>
        <button type="button" class={`${BTN_PRIMARY} ml-auto`} onClick={() => open({ item: null, kind, seed: { group, personaId: scope || null } })}>
          <Plus size={14} />Thêm {LIBRARY_KIND_LABEL[kind].toLowerCase()}
        </button>
      </div>
      <GroupChips items={ofKind} value={group} onChange={setGroup} />

      {!lib.data && <PageState loading={lib.loading} error={lib.error} />}
      {lib.data && shown.length === 0 && (
        <EmptyHint
          title={ofKind.length === 0 ? `Chưa có ${LIBRARY_KIND_LABEL[kind].toLowerCase()} nào` : 'Không có mục khớp'}
          action={ofKind.length === 0 && <button type="button" class={BTN_PRIMARY} onClick={() => open({ item: null, kind, seed: { personaId: scope || null } })}><Plus size={14} />Thêm mục đầu tiên</button>}
        >
          {ofKind.length === 0 ? 'Thêm một mục với tên, nhóm và đoạn prompt tiếng Anh. Có thể kèm ảnh tham khảo.' : 'Thử từ khoá khác hoặc bỏ lọc nhóm.'}
        </EmptyHint>
      )}
      {shown.length > 0 && (
        <ul class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7 gap-3 list-none m-0 p-0">
          {shown.map((it) => (
            <li key={it.id} class="min-w-0 flex flex-col">
              <LibraryTile item={it} onClick={() => open({ item: it, kind: it.kind })} badge={it.gender !== 'all' && !it.personaId ? LIBRARY_GENDER_LABEL[it.gender] : undefined} />
              {it.personaId && <span class="mt-0.5 text-[11px] text-[var(--color-text-faint)] truncate">Chỉ {personaNames.get(it.personaId) ?? 'một KOL'}</span>}
            </li>
          ))}
        </ul>
      )}

      {editor && (
        <LibraryItemEditor
          key={editor.key}
          target={editor.target}
          groups={groups}
          personas={(personas.data?.personas ?? []).filter((p) => p.status !== 'archived').map((p) => ({ id: p.id, name: p.name }))}
          onClose={() => setEditor(null)}
          onCopy={open}
          onSaved={(item) => {
            invalidateFetchCache('/api/m/kol/library');
            if (item?.personaId && item.personaId !== scope) setScope(item.personaId);
            lib.refresh();
          }}
        />
      )}
    </div>
  );
}
