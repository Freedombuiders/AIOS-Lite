import type { RuntimeId } from '@core/types';
import { RUNTIME_LABEL } from '@/lib/labels';
import { RUNTIMES } from '@/lib/teams';

export function RuntimeSelect({ value, onChange, label = 'Runtime' }: { value: RuntimeId; onChange: (r: RuntimeId) => void; label?: string }) {
  return (
    <select class="field" aria-label={label} value={value} onChange={(e) => onChange((e.target as HTMLSelectElement).value as RuntimeId)}>
      {RUNTIMES.map((r) => (
        <option key={r} value={r}>{RUNTIME_LABEL[r] ?? r}</option>
      ))}
    </select>
  );
}
