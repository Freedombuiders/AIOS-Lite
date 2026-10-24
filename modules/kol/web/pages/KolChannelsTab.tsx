/** /kol/:id?tab=channels — Composio connections, linked accounts and their posting rules. */
import { useState } from 'preact/hooks';
import { Link } from 'wouter-preact';
import { Link2 } from 'lucide-preact';
import { PageState } from '@/components/PageState';
import { SetupNotice } from '@modules/kol/web/components/shared/common';
import { BTN_PRIMARY } from '@modules/kol/web/components/shared/ops-shared';
import { AccountCard, LinkAccountModal } from '@modules/kol/web/components/channels';
import { PublishReadiness } from '@modules/kol/web/components/Readiness';
import { EmptyHint } from '@modules/kol/web/components/ui';
import { invalidateFetchCache, useFetch } from '@/lib/useFetch';
import { KOL, type AccountDto, type ConnectionDto, type KolSettingsDto } from '@modules/kol/web/lib/kol';
import type { WorkspaceTabProps } from './workspace-types';

export function KolChannelsTab({ persona, status }: WorkspaceTabProps) {
  const conns = useFetch<{ composio: boolean; connections: ConnectionDto[] }>(KOL.connections);
  const accounts = useFetch<{ accounts: AccountDto[] }>(KOL.accounts(persona.id));
  const settings = useFetch<{ settings: KolSettingsDto }>(KOL.settings);
  const [linking, setLinking] = useState(false);
  const composio = conns.data?.composio;
  const list = accounts.data?.accounts ?? [];

  function changed() {
    invalidateFetchCache(KOL.accounts(persona.id));
    invalidateFetchCache(KOL.personas);
    accounts.refresh();
  }

  return (
    <div class="flex-1 min-h-0 overflow-y-auto px-4 md:px-6 py-4 flex flex-col gap-3">
      {composio === false ? (
        <SetupNotice title="Chưa kết nối Composio">
          KOL Studio đăng lên Facebook, Instagram, TikTok và YouTube qua Composio. Nhập API key ở{' '}
          <Link href="/connections" class="text-[var(--color-accent)] underline">Kết nối › Composio</Link>, kết nối các tài khoản mạng xã hội trong Composio, rồi quay lại đây.
        </SetupNotice>
      ) : (
        <PublishReadiness status={status} publishEnabled={settings.data?.settings.publishEnabled} />
      )}
      {conns.error && <PageState error={conns.error} />}

      <div class="flex flex-wrap items-center gap-2">
        <p class="text-[12.5px] text-[var(--color-text-muted)] max-w-[640px]">
          Mỗi tài khoản có quy tắc riêng: khung giờ, số bài mỗi ngày, khoảng cách giữa hai bài. Bài vi phạm sẽ bị chặn khi lên lịch, kèm lý do.
        </p>
        <button type="button" class={`${BTN_PRIMARY} ml-auto`} disabled={composio === false || !conns.data} onClick={() => setLinking(true)}><Link2 size={14} />Liên kết tài khoản</button>
      </div>

      {!accounts.data && <PageState loading={accounts.loading} error={accounts.error} />}
      {accounts.data && list.length === 0 && (
        <EmptyHint
          icon={<Link2 size={20} />}
          title={`${persona.name} chưa có kênh nào`}
          action={composio !== false && <button type="button" class={BTN_PRIMARY} onClick={() => setLinking(true)}>Liên kết tài khoản đầu tiên</button>}
        >
          Liên kết Facebook Page, Instagram, TikTok hoặc YouTube của KOL. Kết nối được quản lý trong Composio; ở đây bạn chọn tài khoản nào thuộc về KOL này.
        </EmptyHint>
      )}
      {list.length > 0 && (
        <ul class="grid grid-cols-1 lg:grid-cols-2 gap-3 list-none m-0 p-0">
          {list.map((a) => <li key={a.id} class="min-w-0"><AccountCard key={`${a.id}-${a.followersAt ?? 0}`} account={a} onChanged={changed} /></li>)}
        </ul>
      )}

      {linking && (
        <LinkAccountModal
          personaId={persona.id}
          connections={conns.data?.connections ?? []}
          onRefreshConnections={() => { invalidateFetchCache(KOL.connections); conns.refresh(); }}
          onClose={() => setLinking(false)}
          onLinked={changed}
        />
      )}
    </div>
  );
}
