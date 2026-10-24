import { X } from 'lucide-preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { CustomerForm } from './CustomerForm';
import { CustomerTimeline } from './CustomerTimeline';
import { IdentityPanel } from './IdentityPanel';
import type { CareConversationDto } from '@modules/care/web/lib/care/dto';
import type { CustomerAdapter } from '@modules/care/web/lib/care/customer/adapters';
import { careCoreAdapterFor } from '@modules/care/web/lib/care/customer/customerAdapters';
import { anyDirty } from '@modules/care/web/lib/care/dirtyGuard';
import { ct } from '@modules/care/web/lib/care/i18n';
import { pushToast } from '@/lib/toasts';

type Tab = 'profile' | 'timeline' | 'identities';

/** Customer 360 for the open conversation. Closing it with unsaved edits is refused (same rule as switching conversation). */
export function CustomerDrawer({ conversation, participants, variant = 'drawer', onClose, onOpenConversation }: {
  conversation: CareConversationDto;
  /** Sender identities seen in this thread (groups / topics: whose profile to open). */
  participants: string[];
  /** `column`: persistent right column (wide screens); `drawer`: overlay. */
  variant?: 'column' | 'drawer';
  onClose: () => void;
  onOpenConversation: (conversationId: string, messageId: string) => void;
}) {
  const [tab, setTab] = useState<Tab>('profile');
  const grouped = conversation.kind === 'group' || conversation.kind === 'topic';
  const [participant, setParticipant] = useState<string>(grouped ? participants[0] ?? '' : '');
  const adapter = useMemo(() => careCoreAdapterFor(conversation.id, participant || null), [conversation.id, participant]);
  const [customerId, setCustomerId] = useState<string | null>(conversation.primaryCustomerId);
  const [profileKey, setProfileKey] = useState(0);

  function tryClose(): void {
    if (anyDirty()) { pushToast({ tone: 'info', title: ct('customer.closeBlocked') }); return; }
    onClose();
  }
  function selectParticipant(next: string): void {
    if (anyDirty()) { pushToast({ tone: 'info', title: ct('customer.switchBlocked') }); return; }
    setParticipant(next);
  }

  return (
    <aside class={`care-drawer is-${variant}`} aria-label={ct('customer.drawer')} data-testid="care-customer-drawer">
      <header class="care-drawer-head">
        <h2>{ct('customer.drawer')}</h2>
        <button type="button" class="care-icon-button" onClick={tryClose} aria-label={ct('customer.close')} data-testid="care-customer-close"><X size={15} aria-hidden="true" /></button>
      </header>
      {grouped && participants.length > 0 && (
        <div class="care-field care-pad-x">
          <label for="care-participant">{ct('customer.participant')}</label>
          <select id="care-participant" value={participant} onChange={(e) => selectParticipant((e.target as HTMLSelectElement).value)}>
            {participants.map((p, i) => <option key={p} value={p}>{ct('customer.participantN', { n: i + 1, id: p.slice(-4) })}</option>)}
          </select>
        </div>
      )}
      <div class="care-tabs" role="tablist" aria-label={ct('customer.drawer')}>
        {(['profile', 'timeline', 'identities'] as const).map((t) => (
          <button key={t} type="button" role="tab" id={`care-tab-${t}`} aria-selected={tab === t} aria-controls={`care-tabpanel-${t}`} class={`care-tab${tab === t ? ' is-on' : ''}`} onClick={() => setTab(t)} data-testid={`care-tab-${t}`}>
            {ct(`customer.tab.${t}`)}
          </button>
        ))}
      </div>
      <div class="care-drawer-body" role="tabpanel" id={`care-tabpanel-${tab}`} aria-labelledby={`care-tab-${tab}`}>
        {/* The form stays mounted while another tab is open so unsaved edits are not lost by looking elsewhere. */}
        <div hidden={tab !== 'profile'}>
          <CustomerFormBridge key={profileKey} conversation={conversation} adapter={adapter} onCustomer={setCustomerId} />
        </div>
        {tab === 'timeline' && (customerId ? <CustomerTimeline customerId={customerId} onOpen={onOpenConversation} /> : <p class="care-note">{ct('customer.noCustomer')}</p>)}
        {tab === 'identities' && (customerId ? <IdentityPanel customerId={customerId} onChanged={() => { if (anyDirty()) pushToast({ tone: 'info', title: ct('customer.reloadAfterSave') }); else setProfileKey((n) => n + 1); }} /> : <p class="care-note">{ct('customer.noCustomer')}</p>)}
      </div>
    </aside>
  );
}


/** Reports the customer id the adapter resolved (a group participant may differ from the conversation's primary customer). */
function CustomerFormBridge({ conversation, adapter, onCustomer }: { conversation: CareConversationDto; adapter: CustomerAdapter; onCustomer: (id: string | null) => void }) {
  const wrapped = useMemo<CustomerAdapter>(() => ({
    ...adapter,
    async load() {
      const s = await adapter.load();
      onCustomer(s.customerId);
      return s;
    },
  }), [adapter]);
  useEffect(() => () => onCustomer(conversation.primaryCustomerId), []);
  return <CustomerForm adapter={wrapped} dirtyKey={`customer:${conversation.id}`} conversationId={conversation.id} channel={conversation.channel} />;
}
