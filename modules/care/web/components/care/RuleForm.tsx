import { Loader2, TriangleAlert } from 'lucide-preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { careApi } from '@modules/care/web/lib/care/client';
import type { CareAccountDto } from '@modules/care/web/lib/care/dto';
import { toCareFailure, type CareFailure } from '@modules/care/web/lib/care/failure';
import { ct } from '@modules/care/web/lib/care/i18n';
import {
  GROUP_TRIGGERS, KINDS, MODES, SCOPES, SCOPE_SHAPE, conflictIds, policyFieldsFor, policyWarnings, quietModesFor, ruleChannel, toBody, validateRule,
  type PolicyField, type PolicyForm, type RuleForm as RuleFormState, type TriState,
} from '@modules/care/web/lib/care/rules';
import type { CareAssignmentDto } from '@modules/care/server/api/dto-ops';
import { useDebouncedValue } from '@/lib/useDebounce';
import { pushToast } from '@/lib/toasts';

type Check = { state: 'idle' } | { state: 'checking' } | { state: 'ok' } | { state: 'conflict'; ids: string[] } | { state: 'invalid'; warnings: string[] } | { state: 'error'; message: string };

/**
 * Create / edit an assignment. Shape rules per scope are checked locally; ties and invalid policy
 * extensions come from the server's dry run, so the form can never promise something the API refuses.
 */
export function RuleForm({ initial, accounts, agents, rules, onSaved, onCancel }: {
  initial: RuleFormState;
  accounts: CareAccountDto[];
  agents: string[];
  rules: CareAssignmentDto[];
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<RuleFormState>(initial);
  const [check, setCheck] = useState<Check>({ state: 'idle' });
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<CareFailure | null>(null);
  const seq = useRef(0);
  useEffect(() => { setForm(initial); setCheck({ state: 'idle' }); setSaveError(null); }, [initial]);

  const accountsLite = accounts.map((a) => ({ id: a.id, channel: a.channel }));
  const errors = validateRule(form, accountsLite);
  const shapeErrors = errors.filter((e) => e.field !== 'confirmDisabled');
  const errOf = (f: string) => errors.find((e) => e.field === f);
  const channel = ruleChannel(form, accountsLite);
  const shape = SCOPE_SHAPE[form.scope];
  const fields = new Set<PolicyField>(policyFieldsFor(channel));
  const set = (patch: Partial<RuleFormState>) => setForm((f) => ({ ...f, ...patch }));
  const setPolicy = (patch: Partial<PolicyForm>) => setForm((f) => ({ ...f, policy: { ...f.policy, ...patch } }));

  // Server-side validation of ties / policy, debounced; skipped while the shape is still incomplete.
  const key = JSON.stringify(toBodyKey(form, accountsLite));
  const dKey = useDebouncedValue(key, 450);
  useEffect(() => {
    if (shapeErrors.length > 0) { setCheck({ state: 'idle' }); return; }
    const mine = ++seq.current;
    setCheck({ state: 'checking' });
    careApi.saveRule(form.id, toBody(form, accountsLite, { dryRun: true }))
      .then(() => { if (mine === seq.current) setCheck({ state: 'ok' }); })
      .catch((e) => {
        if (mine !== seq.current) return;
        const f = toCareFailure(e);
        if (f.reason === 'PRIORITY_CONFLICT') setCheck({ state: 'conflict', ids: conflictIds(f.details) });
        else if (f.reason === 'INVALID_POLICY_EXT') setCheck({ state: 'invalid', warnings: policyWarnings(f.details) });
        else setCheck({ state: 'error', message: f.code === 'STALE_REVISION' ? ct('rules.staleVersion') : f.message });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dKey]);

  async function save(): Promise<void> {
    if (errors.length > 0 || check.state === 'conflict' || check.state === 'invalid' || busy) return;
    setBusy(true); setSaveError(null);
    try {
      await careApi.saveRule(form.id, toBody(form, accountsLite));
      pushToast({ tone: 'success', title: ct('rules.saved') });
      onSaved();
    } catch (e) {
      const f = toCareFailure(e);
      setSaveError(f);
      if (f.reason === 'PRIORITY_CONFLICT') setCheck({ state: 'conflict', ids: conflictIds(f.details) });
    } finally {
      setBusy(false);
    }
  }

  const label = (r: CareAssignmentDto) => `${ct(`rules.scope.${r.scope}`)} · ${r.scopeTarget ?? r.customerId ?? r.accountId ?? r.channel ?? '*'} · P${r.priority}`;
  const err = (f: string) => { const e = errOf(f); return e ? <span class="care-field-error" role="alert">{ct(`rules.error.${e.code}`)}</span> : null; };
  const id = 'care-rule';

  return (
    <form class="care-rule-form" data-testid="care-rule-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <h2 class="care-section-title">{form.id ? ct('rules.edit') : ct('rules.new')}</h2>

      <div class="care-grid-2">
        <div class="care-field">
          <label for={`${id}-scope`}>{ct('rules.scopeLabel')}</label>
          <select id={`${id}-scope`} value={form.scope} disabled={!!form.id} onChange={(e) => set({ scope: (e.target as HTMLSelectElement).value as RuleFormState['scope'] })} data-testid="care-rule-scope">
            {SCOPES.map((s) => <option key={s} value={s}>{ct(`rules.scope.${s}`)}</option>)}
          </select>
          <span class="care-faint">{ct(`rules.scopeHint.${form.scope}`)}</span>
        </div>
        <div class="care-field">
          <label for={`${id}-priority`}>{ct('rules.priority')}</label>
          <input id={`${id}-priority`} type="text" inputMode="numeric" value={form.priority} onInput={(e) => set({ priority: (e.target as HTMLInputElement).value })} aria-invalid={!!errOf('priority')} data-testid="care-rule-priority" />
          {err('priority')}
          <span class="care-faint">{ct('rules.priorityHint')}</span>
        </div>
      </div>

      {shape.account !== 'none' && (
        <div class="care-field">
          <label for={`${id}-account`}>{ct('rules.account')}{shape.account === 'optional' ? ` (${ct('rules.optional')})` : ''}</label>
          <select id={`${id}-account`} value={form.accountId} onChange={(e) => set({ accountId: (e.target as HTMLSelectElement).value })} aria-invalid={!!errOf('accountId')} data-testid="care-rule-account">
            <option value="">{shape.account === 'optional' ? ct('rules.anyAccount') : ct('rules.chooseAccount')}</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.label} ({ct(`channel.${a.channel}`)})</option>)}
          </select>
          {err('accountId')}
        </div>
      )}
      {shape.channel !== 'none' && (
        <div class="care-field">
          <label for={`${id}-channel`}>{ct('rules.channel')}</label>
          <select id={`${id}-channel`} value={form.channel} onChange={(e) => set({ channel: (e.target as HTMLSelectElement).value as RuleFormState['channel'] })} aria-invalid={!!errOf('channel')}>
            <option value="">{ct('rules.chooseChannel')}</option>
            {(['zalo', 'email'] as const).map((c) => <option key={c} value={c}>{ct(`channel.${c}`)}</option>)}
          </select>
          {err('channel')}
        </div>
      )}
      {shape.customer !== 'none' && (
        <div class="care-field">
          <label for={`${id}-customer`}>{ct('rules.customerId')}</label>
          <input id={`${id}-customer`} type="text" value={form.customerId} onInput={(e) => set({ customerId: (e.target as HTMLInputElement).value })} aria-invalid={!!errOf('customerId')} />
          {err('customerId')}
        </div>
      )}
      {shape.target !== 'none' && (
        <div class="care-field">
          <label for={`${id}-target`}>{ct(`rules.target.${form.scope}`)}</label>
          <input id={`${id}-target`} type="text" value={form.scopeTarget} onInput={(e) => set({ scopeTarget: (e.target as HTMLInputElement).value })} aria-invalid={!!errOf('scopeTarget')} />
          {err('scopeTarget')}
        </div>
      )}

      <div class="care-grid-2">
        <div class="care-field">
          <label for={`${id}-mode`}>{ct('rules.mode')}</label>
          <select id={`${id}-mode`} value={form.mode} onChange={(e) => set({ mode: (e.target as HTMLSelectElement).value as RuleFormState['mode'] })} data-testid="care-rule-mode">
            {MODES.map((m) => <option key={m} value={m}>{ct(`rules.modes.${m}`)}</option>)}
          </select>
          <span class="care-faint">{ct(`rules.modeHint.${form.mode}`)}</span>
        </div>
        <div class="care-field">
          <label for={`${id}-agent`}>{ct('rules.agent')}</label>
          <input id={`${id}-agent`} type="text" list="care-rule-agents" value={form.agentId} placeholder={ct('rules.agentDefault')} onInput={(e) => set({ agentId: (e.target as HTMLInputElement).value })} />
          <datalist id="care-rule-agents">{agents.map((a) => <option key={a} value={a} />)}</datalist>
        </div>
      </div>

      <label class="care-check">
        <input type="checkbox" checked={form.enabled} onChange={() => set({ enabled: !form.enabled, confirmDisabled: false })} data-testid="care-rule-enabled" /> {ct('rules.enabled')}
      </label>
      {!form.enabled && (
        <div class="care-banner is-warn care-deny" role="alert" data-testid="care-rule-deny">
          <TriangleAlert size={13} aria-hidden="true" />
          <span>
            {ct('rules.denyWarning')}
            <label class="care-check">
              <input type="checkbox" checked={form.confirmDisabled} onChange={() => set({ confirmDisabled: !form.confirmDisabled })} data-testid="care-rule-confirm-deny" /> {ct('rules.denyConfirm')}
            </label>
          </span>
        </div>
      )}

      <details class="care-policy" open>
        <summary>{ct('rules.policy')} <span class="care-faint">({channel ? ct(`channel.${channel}`) : ct('rules.allChannels')})</span></summary>
        <p class="care-faint">{ct('rules.policyHint')}</p>
        <div class="care-grid-2">
          {fields.has('groupTrigger') && (
            <div class="care-field"><label for={`${id}-gt`}>{ct('rules.p.groupTrigger')}</label>
              <select id={`${id}-gt`} value={form.policy.groupTrigger} onChange={(e) => setPolicy({ groupTrigger: (e.target as HTMLSelectElement).value as PolicyForm['groupTrigger'] })}>
                <option value="">{ct('rules.inherit')}</option>{GROUP_TRIGGERS.map((g) => <option key={g} value={g}>{ct(`rules.trigger.${g}`)}</option>)}
              </select></div>
          )}
          {fields.has('quietHoursMode') && (
            <div class="care-field"><label for={`${id}-qh`}>{ct('rules.p.quietHoursMode')}</label>
              <select id={`${id}-qh`} value={form.policy.quietHoursMode} onChange={(e) => setPolicy({ quietHoursMode: (e.target as HTMLSelectElement).value as PolicyForm['quietHoursMode'] })} aria-invalid={!!errOf('quietHoursMode')}>
                <option value="">{ct('rules.inherit')}</option>{quietModesFor(channel).map((m) => <option key={m} value={m}>{ct(`rules.quiet.${m}`)}</option>)}
              </select>{err('quietHoursMode')}</div>
          )}
          {(['maxRepliesPerThreadDay', 'humanPauseMinutes', 'autoDelaySeconds'] as const).filter((k) => fields.has(k)).map((k) => (
            <div class="care-field" key={k}><label for={`${id}-${k}`}>{ct(`rules.p.${k}`)}</label>
              <input id={`${id}-${k}`} type="text" inputMode="numeric" placeholder={ct('rules.inherit')} value={form.policy[k]} onInput={(e) => setPolicy({ [k]: (e.target as HTMLInputElement).value } as Partial<PolicyForm>)} aria-invalid={!!errOf(k)} />{err(k)}</div>
          ))}
          {(['primaryOnly', 'replyToAllMention'] as const).filter((k) => fields.has(k)).map((k) => (
            <div class="care-field" key={k}><label for={`${id}-${k}`}>{ct(`rules.p.${k}`)}</label>
              <select id={`${id}-${k}`} value={form.policy[k]} onChange={(e) => setPolicy({ [k]: (e.target as HTMLSelectElement).value as TriState } as Partial<PolicyForm>)}>
                <option value="">{ct('rules.inherit')}</option><option value="true">{ct('rules.yes')}</option><option value="false">{ct('rules.no')}</option>
              </select></div>
          ))}
        </div>
        {(['triggerKeywords', 'handoffKeywords', 'reviewKeywords'] as const).filter((k) => fields.has(k)).map((k) => (
          <div class="care-field" key={k}><label for={`${id}-${k}`}>{ct(`rules.p.${k}`)}</label>
            <input id={`${id}-${k}`} type="text" placeholder={ct('rules.keywordsPlaceholder')} value={form.policy[k]} onInput={(e) => setPolicy({ [k]: (e.target as HTMLInputElement).value } as Partial<PolicyForm>)} /></div>
        ))}
        {fields.has('conversationKinds') && (
          <fieldset class="care-kinds"><legend>{ct('rules.p.conversationKinds')}</legend>
            {KINDS.map((k) => (
              <label key={k} class="care-check"><input type="checkbox" checked={form.policy.conversationKinds.includes(k)} onChange={() => setPolicy({ conversationKinds: form.policy.conversationKinds.includes(k) ? form.policy.conversationKinds.filter((x) => x !== k) : [...form.policy.conversationKinds, k] })} /> {ct(`kind.${k}`)}</label>
            ))}
            <span class="care-faint">{ct('rules.kindsHint')}</span>
          </fieldset>
        )}
        {fields.has('instructions') && (
          <div class="care-field"><label for={`${id}-instr`}>{ct('rules.p.instructions')}</label>
            <textarea id={`${id}-instr`} rows={3} value={form.policy.instructions} onInput={(e) => setPolicy({ instructions: (e.target as HTMLTextAreaElement).value })} /></div>
        )}
        {Object.keys(form.extra).length > 0 && <p class="care-faint">{ct('rules.extraKept', { keys: Object.keys(form.extra).join(', ') })}</p>}
      </details>

      <div class="care-check-state" aria-live="polite" data-testid="care-rule-check">
        {check.state === 'checking' && <span class="care-faint"><Loader2 size={11} class="animate-spin" aria-hidden="true" /> {ct('rules.checking')}</span>}
        {check.state === 'ok' && <span class="care-ok">{ct('rules.checkOk')}</span>}
        {check.state === 'conflict' && (
          <div class="care-banner is-error" role="alert" data-testid="care-rule-conflict">
            <span>{ct('rules.conflict')}{' '}{check.ids.map((i) => rules.find((r) => r.id === i)).filter((r): r is CareAssignmentDto => !!r).map(label).join('; ')}</span>
          </div>
        )}
        {check.state === 'invalid' && <div class="care-banner is-error" role="alert"><span>{ct('rules.invalidPolicy')} {check.warnings.join('; ')}</span></div>}
        {check.state === 'error' && <div class="care-banner is-warn" role="alert"><span>{check.message}</span></div>}
        {saveError && saveError.reason !== 'PRIORITY_CONFLICT' && <div class="care-banner is-error" role="alert" data-testid="care-rule-save-error"><span>{saveError.code === 'STALE_REVISION' ? ct('rules.staleVersion') : saveError.message}</span></div>}
      </div>

      <div class="care-composer-actions">
        <button type="submit" class="cc-button is-primary" disabled={busy || errors.length > 0 || check.state === 'conflict' || check.state === 'invalid' || check.state === 'checking'} data-testid="care-rule-save">
          {busy && <Loader2 size={12} class="animate-spin" aria-hidden="true" />} {ct('rules.save')}
        </button>
        <button type="button" class="cc-button" onClick={onCancel}>{ct('identity.cancel')}</button>
      </div>
    </form>
  );
}

/** The part of the form that decides validity on the server (confirmDisabled is a UI-only gate). */
function toBodyKey(form: RuleFormState, accounts: Array<{ id: string; channel: 'zalo' | 'telegram' | 'email' }>): unknown {
  const { dryRun: _d, ...body } = toBody(form, accounts, { dryRun: true });
  return body;
}
