// "Ai trả lời ở đâu": the care rules in one table. Add / edit opens the rule form in a drawer; delete asks in-page.
import { Plus, Trash2 } from 'lucide-preact';
import { useMemo, useState } from 'preact/hooks';
import { ConfirmModal } from '@/components/ConfirmModal';
import { EffectiveRulePreview } from '@modules/care/web/components/care/EffectiveRulePreview';
import { RuleForm } from '@modules/care/web/components/care/RuleForm';
import { ct } from '@modules/care/web/lib/care/i18n';
import { careApi } from '@modules/care/web/lib/care/client';
import type { CareAccountDto } from '@modules/care/web/lib/care/dto';
import { toCareFailure } from '@modules/care/web/lib/care/failure';
import { emptyRule, fromAssignment, type RuleForm as CoreRuleForm } from '@modules/care/web/lib/care/rules';
import { cc } from '@modules/care/web/lib/care-channels/i18n';
import { buildRuleRows, keywordsSummary, type RuleLabels, type RuleRow } from '@modules/care/web/lib/care-channels/rules';
import { resolveAgentName } from '@/lib/format';
import { pushToast } from '@/lib/toasts';
import type { CareAssignmentDto } from '@modules/care/server/api/dto-ops';
import { ChannelTag } from './ChannelTag';
import { SideDrawer } from './EditorShell';

type AgentOption = { id: string; name: string };

type Editor = { form: CoreRuleForm };

function appliesText(r: RuleRow): string {
  const params = { account: r.accountLabel, subject: r.subject };
  if (r.target === 'channel' && !r.accountLabel) return r.channel ? cc('rules.applies.channelAll', { channel: cc(`channel.${r.channel}`) }) : cc('rules.applies.everything');
  return cc(`rules.applies.${r.target}`, params);
}

function ownerText(r: RuleRow): { text: string; muted: boolean; note?: string } {
  if (r.owner === 'none') return { text: cc('rules.owner.none'), muted: true };
  if (r.owner === 'human') return { text: cc('rules.owner.you'), muted: false, note: r.agentId ? cc('rules.owner.watching', { agent: resolveAgentName(r.agentId) }) : undefined };
  return { text: `${r.agentId ? resolveAgentName(r.agentId) : '?'} (AI)`, muted: false };
}

export function RulesSection({ careAccounts, coreRules, agents, onChanged }: {
  careAccounts: CareAccountDto[]; coreRules: CareAssignmentDto[]; agents: AgentOption[]; onChanged: () => void;
}) {
  const [editor, setEditor] = useState<Editor | null>(null);
  const [removing, setRemoving] = useState<RuleRow | null>(null);

  const labels: RuleLabels = useMemo(() => ({ care: Object.fromEntries(careAccounts.map((a) => [a.id, a.label])) }), [careAccounts]);
  const rows = useMemo(() => buildRuleRows({ core: coreRules, labels }), [coreRules, labels]);

  function edit(r: RuleRow): void {
    setEditor({ form: fromAssignment(r.raw) });
  }

  async function remove(r: RuleRow): Promise<void> {
    try {
      await careApi.deleteRule(r.raw.id, r.raw.configVersion);
      pushToast({ tone: 'success', title: cc('rules.deleted') });
    } catch (err) {
      const f = toCareFailure(err);
      pushToast({ tone: 'error', title: cc('rules.deleteFailed'), description: f.code === 'STALE_REVISION' ? cc('rules.stale') : f.message });
    }
    onChanged();
  }

  return (
    <section class="cch-section" id="rules" aria-labelledby="cch-rules-h" data-testid="cch-rules">
      <div class="cch-section-head">
        <h2 id="cch-rules-h" class="cch-h2">{cc('rules.title')}</h2>
        <button type="button" class="cch-btn" onClick={() => setEditor({ form: emptyRule() })} data-testid="cch-rule-add"><Plus size={13} aria-hidden="true" /> {cc('rules.add')}</button>
      </div>

      {rows.length === 0 ? (
        <div class="cch-empty" data-testid="cch-rules-empty">{cc('rules.empty')}<p>{cc('rules.emptyHint')}</p></div>
      ) : (
        <div class="cch-table-wrap">
          <table class="cch-table">
            <thead>
              <tr>
                <th scope="col">{cc('rules.col.applies')}</th>
                <th scope="col">{cc('rules.col.owner')}</th>
                <th scope="col">{cc('rules.col.mode')}</th>
                <th scope="col">{cc('rules.col.keywords')}</th>
                <th scope="col"><span class="care-sr-only">{cc('rules.col.actions')}</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const owner = ownerText(r);
                const kw = keywordsSummary(r.keywords);
                return (
                  <tr key={r.key} class={r.enabled ? '' : 'is-off'} data-testid="cch-rule-row" data-key={r.key} data-level={r.level}>
                    <td>
                      <ChannelTag channel={r.channel} />
                      {(r.level === 'conversation' || r.level === 'customer') && <span class="cch-tag">{cc(r.level === 'customer' ? 'rules.level.customer' : 'rules.level.conversation')}</span>}
                      {appliesText(r)}
                    </td>
                    <td class={owner.muted ? 'cch-muted' : ''}>{owner.text}{owner.note && <span class="cch-from-inbox">{owner.note}</span>}</td>
                    <td class={r.aiMode === 'off' ? 'cch-ai-off' : 'cch-ai-on'}>{r.enabled ? cc(`mode.${r.aiMode}`) : cc('mode.disabled')}</td>
                    <td class="cch-kw">{kw ? cc(r.keywordsKind === 'review' ? 'rules.kw.review' : 'rules.kw.handoff', { list: kw }) : '—'}</td>
                    <td class="is-actions">
                      <button type="button" class="care-link-button" onClick={() => edit(r)} data-testid="cch-rule-edit">{cc('rules.edit')}</button>
                      <button type="button" class="care-icon-button" onClick={() => setRemoving(r)} aria-label={cc('rules.delete')} data-testid="cch-rule-delete"><Trash2 size={13} aria-hidden="true" /></button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p class="cch-note">{cc('rules.precedence')}</p>
      <details class="cch-effective" data-testid="cch-effective">
        <summary class="care-link-button">{ct('rules.effectiveTitle')}</summary>
        <EffectiveRulePreview rules={coreRules} />
      </details>

      {editor && (
        <SideDrawer title={editor.form.id ? cc('rules.editCore') : cc('rules.addCore')} width={560} onClose={() => setEditor(null)} testId="cch-rule-drawer">
          <RuleForm initial={editor.form} accounts={careAccounts} agents={agents.map((a) => a.id)} rules={coreRules} onSaved={() => { setEditor(null); pushToast({ tone: 'success', title: cc('rules.saved') }); onChanged(); }} onCancel={() => setEditor(null)} />
        </SideDrawer>
      )}

      <ConfirmModal
        open={removing !== null}
        onClose={() => setRemoving(null)}
        onConfirm={() => { if (removing) void remove(removing); setRemoving(null); }}
        title={cc('rules.deleteTitle')}
        body={removing ? cc('rules.deleteBody', { target: appliesText(removing) }) : ''}
                confirmLabel={cc('rules.delete')}
        cancelLabel={cc('cancel')}
        destructive
      />
    </section>
  );
}
