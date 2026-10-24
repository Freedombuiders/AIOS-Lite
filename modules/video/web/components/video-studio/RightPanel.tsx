// Right column: segmented tabs Quy trình | Kho | Xem trước.
import { rightTab, type RightTab } from '@modules/video/web/lib/video-edit/studio';
import { AssetPanel } from './AssetPanel';
import { PreviewPanel } from './PreviewPanel';
import { TicketPanel } from './TicketPanel';

const TABS: { id: RightTab; label: string }[] = [
  { id: 'ticket', label: 'Quy trình' },
  { id: 'assets', label: 'Kho' },
  { id: 'preview', label: 'Xem trước' },
];

export function RightPanel() {
  const tab = rightTab.value;
  return (
    <aside class="vs-right" aria-label="Bảng điều khiển bên phải">
      <div class="vs-seg" role="tablist" aria-label="Chế độ xem">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`vs-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls="vs-right-body"
            class={tab === t.id ? 'is-active' : ''}
            onClick={() => { rightTab.value = t.id; }}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div class="vs-right-body" id="vs-right-body" role="tabpanel" aria-labelledby={`vs-tab-${tab}`}>
        {tab === 'ticket' && <TicketPanel />}
        {tab === 'assets' && <AssetPanel />}
        {tab === 'preview' && <PreviewPanel />}
      </div>
    </aside>
  );
}
