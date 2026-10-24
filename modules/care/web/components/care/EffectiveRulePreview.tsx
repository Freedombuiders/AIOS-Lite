import { useEffect, useState } from 'preact/hooks';
import { PageState } from '@/components/PageState';
import { careApi } from '@modules/care/web/lib/care/client';
import type { CareConversationDto } from '@modules/care/web/lib/care/dto';
import type { CareAssignmentDto, CareEffectiveRuleDto } from '@modules/care/server/api/dto-ops';
import { toCareFailure } from '@modules/care/web/lib/care/failure';
import { ct } from '@modules/care/web/lib/care/i18n';
import { useDebouncedValue } from '@/lib/useDebounce';

/** "Which rule applies to this conversation, and why": the same walk the agent turn uses, with its trace. */
export function EffectiveRulePreview({ rules }: { rules: CareAssignmentDto[] }) {
  const [q, setQ] = useState('');
  const dq = useDebouncedValue(q, 300).trim();
  const [options, setOptions] = useState<CareConversationDto[]>([]);
  const [picked, setPicked] = useState<CareConversationDto | null>(null);
  const [result, setResult] = useState<CareEffectiveRuleDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let live = true;
    const p = new URLSearchParams({ limit: '8' });
    if (dq.length >= 2) p.set('q', dq);
    careApi.conversations(p.toString()).then((r) => { if (live) setOptions(r.items); }).catch(() => { if (live) setOptions([]); });
    return () => { live = false; };
  }, [dq]);

  async function pick(c: CareConversationDto): Promise<void> {
    setPicked(c); setLoading(true); setError(null); setResult(null);
    try { setResult(await careApi.effectiveRule(c.id)); } catch (e) { setError(toCareFailure(e).message); } finally { setLoading(false); }
  }
  const nameOf = (id: string) => { const r = rules.find((x) => x.id === id); return r ? `${ct(`rules.scope.${r.scope}`)} · ${r.scopeTarget ?? r.agentId ?? id.slice(-6)} · P${r.priority}` : id.slice(-6); };

  return (
    <section class="care-effective" aria-label={ct('rules.effectiveTitle')} data-testid="care-effective">
      <h2 class="care-section-title">{ct('rules.effectiveTitle')}</h2>
      <p class="care-faint">{ct('rules.effectiveHint')}</p>
      <div class="care-field">
        <label for="care-eff-search">{ct('rules.effectivePick')}</label>
        <input id="care-eff-search" type="search" value={q} placeholder={ct('filters.searchPlaceholder')} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
      </div>
      <ul class="care-found">
        {options.map((c) => (
          <li key={c.id}><button type="button" class={`care-hit${picked?.id === c.id ? ' is-on' : ''}`} onClick={() => void pick(c)} data-testid="care-eff-option"><span class="care-row-title">{c.title || ct('list.untitled')}</span><span class="care-faint">{ct(`channel.${c.channel}`)}</span></button></li>
        ))}
      </ul>
      {loading && <PageState loading />}
      {error && <PageState error={error} />}
      {result && (
        <div class="care-effective-result" data-testid="care-effective-result" data-outcome={result.outcome}>
          <p>
            <span class={`care-status-chip tone-${result.outcome === 'active' ? 'done' : result.outcome === 'none' ? 'neutral' : 'failed'}`}>{ct(`rules.outcome.${result.outcome}`)}</span>{' '}
            {ct(`rules.outcomeHint.${result.outcome}`)}
          </p>
          {result.rule && (
            <dl class="care-kv">
              <div><dt>{ct('rules.winner')}</dt><dd>{nameOf(result.rule.assignmentId)}{result.rule.viaKindPredicate ? ` · ${ct('rules.viaKind')}` : ''}</dd></div>
              <div><dt>{ct('rules.mode')}</dt><dd>{ct(`rules.modes.${result.rule.mode}`)}</dd></div>
              <div><dt>{ct('rules.agent')}</dt><dd>{result.rule.agentId || '—'}</dd></div>
            </dl>
          )}
          {result.conflict && (
            <div class="care-banner is-error" role="alert" data-testid="care-effective-conflict">
              <span>{ct('rules.effectiveConflict', { tier: ct(`rules.scope.${result.conflict.tier}`), priority: result.conflict.priority })} {result.conflict.assignmentIds.map(nameOf).join('; ')}</span>
            </div>
          )}
          {result.warnings.length > 0 && <ul class="care-warnings">{result.warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
          <details>
            <summary>{ct('rules.trace')}</summary>
            <ol class="care-trace">
              {result.trace.map((t) => (
                <li key={t.tier}>
                  <strong>{ct(`rules.scope.${t.tier}`)}</strong>
                  {t.candidates.length === 0 ? <span class="care-faint"> {ct('rules.noCandidates')}</span> : (
                    <ul>{t.candidates.map((c) => <li key={c.assignmentId}>{nameOf(c.assignmentId)}{c.enabled ? '' : ` (${ct('rules.denied')})`}{t.selectedId === c.assignmentId ? ` ← ${ct('rules.selected')}` : ''}</li>)}</ul>
                  )}
                </li>
              ))}
            </ol>
          </details>
        </div>
      )}
    </section>
  );
}
