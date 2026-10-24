import { useState } from 'preact/hooks';
import type { EmailAccount } from '../../../lib/email';
export function SignatureEditor({ account, save }: { account: EmailAccount; save: (signature: string) => Promise<void> }) {
  const [signature, setSignature] = useState(account.signature);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return <form onSubmit={async e => { e.preventDefault(); setBusy(true); setError(''); try { await save(signature); } catch { setError('Không lưu được chữ ký.'); } finally { setBusy(false); } }}>
    <label class="block">Chữ ký cho {account.emailAddress}<textarea class="block w-full rounded border p-2 bg-transparent" maxLength={1000} rows={3} value={signature} onInput={e => setSignature(e.currentTarget.value)} /></label>
    {error && <p role="alert">{error}</p>}<button class="control-button control-accent mt-2" disabled={busy}>{busy ? 'Đang lưu…' : 'Lưu chữ ký'}</button>
  </form>;
}
