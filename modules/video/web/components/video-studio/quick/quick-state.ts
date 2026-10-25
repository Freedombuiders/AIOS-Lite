// Dựng nhanh state shared by the three screens: the template list (GET /templates) and the
// Trang đầu draft (video file, note, template) carried into Thiết lập.
import { signal } from '@preact/signals';
import { errorMessage } from '@modules/video/web/lib/video-edit/api';
import { quickApi, type TemplateSummary } from '@modules/video/web/lib/video-edit/quick-api';

export const templates = signal<TemplateSummary[]>([]);
export const templatesStatus = signal<'idle' | 'loading' | 'ready' | 'error'>('idle');
export const templatesError = signal('');

export async function loadTemplates(force = false) {
  if (!force && (templatesStatus.value === 'loading' || templatesStatus.value === 'ready')) return;
  templatesStatus.value = 'loading';
  try {
    const r = await quickApi.templates();
    templates.value = r.templates ?? [];
    templatesStatus.value = 'ready';
  } catch (e) {
    templatesError.value = errorMessage(e);
    templatesStatus.value = 'error';
  }
}

export function templateById(id: string | null | undefined): TemplateSummary | undefined {
  return id ? templates.value.find((t) => t.id === id) : undefined;
}

/** Trang đầu → Thiết lập. `projectId` is set once the project exists, so the note follows only it. */
export const quickDraft = signal<{ file: File | null; note: string; templateId: string | null; projectId: string | null }>({
  file: null, note: '', templateId: null, projectId: null,
});

export function patchDraft(patch: Partial<typeof quickDraft.value>) {
  quickDraft.value = { ...quickDraft.value, ...patch };
}
