// "Đăng nhập chủ" screen: opens when an owner route refuses the request (src/api/owner.ts, web/src/lib/owner.ts).
import { useState } from 'preact/hooks';
import { KeyRound } from 'lucide-preact';
import { Modal } from '@/components/Modal';
import { ownerPrompt, pairWithCode, requestNewCode } from '@/lib/owner';
import { pushToast } from '@/lib/toasts';

const LEAD: Record<string, string> = {
  required: 'Việc bạn vừa làm (gửi tin cho khách, duyệt hoặc đăng bài, đổi quảng cáo, cài đặt module, quyền agent...) chỉ chủ được làm. Trình duyệt này chưa đăng nhập chủ, hoặc phiên đăng nhập đã hết hạn.',
  'cross-site': 'Yêu cầu vừa rồi bị chặn vì không đến từ chính trang AIOS-Lite. Hãy mở AIOS-Lite trực tiếp bằng địa chỉ máy chủ (không qua trang khác) rồi làm lại.',
  'pair-failed': 'Liên kết đăng nhập không dùng được: mã đã dùng, đã hết hạn hoặc không đúng.',
};

export function OwnerSignIn() {
  const kind = ownerPrompt.value;
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  if (!kind) return null;

  const close = () => {
    ownerPrompt.value = null;
    setError('');
    setNote('');
  };
  const submit = async (e: Event) => {
    e.preventDefault();
    if (!code.trim()) return;
    setBusy(true);
    setError('');
    const r = await pairWithCode(code);
    setBusy(false);
    if (!r.ok) {
      setError(r.message);
      return;
    }
    setCode('');
    close();
    pushToast({ tone: 'success', title: 'Đã đăng nhập chủ trên trình duyệt này', description: 'Làm lại thao tác vừa bị chặn.' });
  };
  const askNew = async () => {
    const r = await requestNewCode();
    setNote(r.printed ? 'Đã in mã mới ở cửa sổ terminal đang chạy AIOS-Lite.' : r.retryInSec ? `Vừa in mã rồi, đợi ${r.retryInSec} giây hoặc xem terminal.` : 'Không yêu cầu được mã mới, kiểm tra máy chủ.');
  };

  return (
    <Modal open title="Đăng nhập chủ" onClose={close} width={460}>
      <form class="flex flex-col gap-3" onSubmit={submit}>
        <div class="flex items-start gap-2.5">
          <span class="mt-0.5 text-[var(--color-accent)]"><KeyRound size={18} /></span>
          <p class="m-0 text-[13px] leading-relaxed">{LEAD[kind]}</p>
        </div>
        {kind !== 'cross-site' && (
          <>
            <ol class="m-0 flex flex-col gap-1 pl-5 text-[13px] leading-relaxed text-[var(--color-text-muted)]">
              <li>Mở cửa sổ terminal đang chạy AIOS-Lite (lệnh <code>npm start</code> hoặc <code>npm run dev</code>).</li>
              <li>Tìm khung <b>Đăng nhập chủ AIOS-Lite</b>: mở liên kết trong đó, hoặc nhập mã dạng <code>ABCD-EFGH-JKLM</code> vào ô dưới.</li>
              <li>Không thấy mã, hoặc mã đã hết hạn (60 phút)? Bấm <b>In mã mới</b> rồi xem lại terminal.</li>
            </ol>
            <label class="flex flex-col gap-1 text-[12px] font-medium">
              Mã ghép
              <input
                class="field font-mono tracking-wider uppercase"
                autocomplete="off"
                spellcheck={false}
                placeholder="ABCD-EFGH-JKLM"
                value={code}
                onInput={(e) => setCode((e.target as HTMLInputElement).value)}
              />
            </label>
            {error && <div class="text-[12px] text-[var(--color-status-failed)]">{error}</div>}
            {note && <div class="hint">{note}</div>}
            <p class="hint m-0">Mã chỉ hiện ở terminal của máy chủ, không bao giờ gửi qua trình duyệt hay cho agent. Đừng dán mã vào khung chat với agent.</p>
            <div class="flex items-center justify-end gap-2">
              <button type="button" class="control-button" onClick={() => void askNew()}>In mã mới</button>
              <button type="submit" class="control-button control-accent" disabled={busy || !code.trim()}>{busy ? 'Đang đăng nhập…' : 'Đăng nhập'}</button>
            </div>
          </>
        )}
      </form>
    </Modal>
  );
}
