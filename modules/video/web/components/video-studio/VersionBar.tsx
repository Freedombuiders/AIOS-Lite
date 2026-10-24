// Plan version switch (v1..vN) in the editor header.
import { showVersion, viewVersion } from '@modules/video/web/lib/video-edit/editor';
import type { PlanStatus } from '@modules/video/web/lib/video-edit/api';

const STATUS_TEXT: Record<PlanStatus, string> = {
  draft: 'đang sửa', waiting_approval: 'chờ duyệt', approved: 'đã duyệt', rejected: 'đã huỷ',
};

export function VersionBar({ latest, status }: { latest: number; status?: PlanStatus }) {
  if (latest < 1) return null;
  const current = viewVersion.value ?? latest;
  const versions = Array.from({ length: latest }, (_, i) => i + 1);
  const label = (v: number) => (v === latest ? `v${v}${status ? ` · ${STATUS_TEXT[status]}` : ''}` : `v${v}`);
  if (latest > 6) {
    return (
      <label class="vs-ver-select">
        <span class="sr-only">Phiên bản kế hoạch</span>
        <select class="vs-input" value={current} onChange={(e) => void showVersion(Number(e.currentTarget.value))}>
          {versions.slice().reverse().map((v) => <option key={v} value={v}>{label(v)}</option>)}
        </select>
      </label>
    );
  }
  return (
    <div class="vs-ver" role="radiogroup" aria-label="Phiên bản kế hoạch">
      {versions.map((v) => (
        <button key={v} type="button" role="radio" aria-checked={v === current} class={v === current ? 'is-on' : ''} onClick={() => void showVersion(v)}>{label(v)}</button>
      ))}
    </div>
  );
}
