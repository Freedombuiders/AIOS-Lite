import { Mail } from 'lucide-preact';
import { defineWebModule } from '@/module-host/contracts';
import EmailAccounts from './pages/EmailAccounts';
function GmailPanel({ channel }: { channel?: string }) {
  if (channel && channel !== 'email') return null;
  return <p>Gmail: trả lời trong luồng thư gốc, kèm chữ ký của tài khoản. <a class="underline" href="/m/gmail">Quản lý tài khoản</a></p>;
}
function GmailComposerExtras({ channel }: { channel?: string }) {
  return channel && channel !== 'email' ? null : <p>Chữ ký được thêm khi gửi. Chưa hỗ trợ tệp đính kèm.</p>;
}
export default defineWebModule({
  id: 'gmail',
  nav: [{ group: 'sales', label: 'Gmail', path: '/m/gmail', icon: Mail }],
  routes: [{ path: '/m/gmail', component: EmailAccounts }],
  provides: { 'care.channelPanel': GmailPanel, 'care.composerExtras': GmailComposerExtras },
});
