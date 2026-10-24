import { ChannelBadge } from '../ChannelBadge';
import type { CareLinkPreviewDto } from '@modules/care/server/api/dto-ops';
import type { LinkChoices, ResolutionChoice } from '@modules/care/web/lib/care/customer/link';
import { ct } from '@modules/care/web/lib/care/i18n';

/** What a link would do, and one explicit choice per conflicting customer field. Nothing moves until confirmed. */
export function LinkPreview({ preview, choices, onChoices, needFields }: {
  preview: CareLinkPreviewDto;
  choices: LinkChoices;
  onChoices: (c: LinkChoices) => void;
  /** Fields the server said still need a decision (409 UNDECIDED_ITEMS). */
  needFields: string[];
}) {
  const nameOf = (id: string) => preview.people.find((p) => p.customerId === id)?.displayName ?? `#${id.slice(-6)}`;
  const setField = (field: string, c: ResolutionChoice) => onChoices({ ...choices, fields: { ...choices.fields, [field]: c } });

  return (
    <div class="care-link-preview" data-testid="care-link-preview">
      {preview.noop && <div class="care-banner is-info" role="status"><span>{ct('identity.noop')}</span></div>}
      <p class="care-faint">{ct('identity.previewIntro')}</p>
      <ul class="care-people">
        {preview.people.map((p) => (
          <li key={p.customerId}>
            <strong>{p.displayName}</strong> <span class="care-chip">{p.role === 'target' ? ct('identity.roleTarget') : ct('identity.roleSource')}</span>
            {p.movingIdentityIds.length > 0 && <span class="care-faint"> {ct('identity.moving', { n: p.movingIdentityIds.length })}</span>}
          </li>
        ))}
      </ul>
      <div class="care-row-meta">
        {preview.channels.map((c) => <ChannelBadge key={c} channel={c} />)}
        {preview.accounts.map((a) => <span key={a.accountId} class="care-chip">{a.label}</span>)}
      </div>
      <p class="care-faint">{ct('identity.moves', { profiles: preview.moves.profiles, tasks: preview.moves.tasks, conversations: preview.moves.conversations })}</p>
      <p class="care-faint">{ct('identity.messagesStay')}</p>

      {preview.conflicts.length > 0 && (
        <fieldset class="care-conflicts" data-testid="care-conflicts">
          <legend>{ct('identity.conflicts')}</legend>
          {preview.conflicts.map((c) => {
            const choice = choices.fields[c.field];
            const need = needFields.includes(c.field) && choice === undefined;
            return (
              <div key={c.field} class={`care-conflict${need ? ' is-needed' : ''}`} data-testid={`care-conflict-${c.field}`} role="group" aria-label={ct(`customer.${c.field}`)}>
                <strong>{ct(`customer.${c.field}`)}</strong>
                {need && <span class="care-field-error" role="alert">{ct('identity.fieldNeeded')}</span>}
                <label><input type="radio" name={`conf-${c.field}`} checked={choice?.mode === 'target'} onChange={() => setField(c.field, { mode: 'target' })} /> {ct('identity.keepTarget')}</label>
                {c.values.map((v) => (
                  <label key={v.customerId}>
                    <input type="radio" name={`conf-${c.field}`} checked={choice?.mode === 'customer' && choice.customerId === v.customerId} onChange={() => setField(c.field, { mode: 'customer', customerId: v.customerId })} />
                    {ct('identity.takeFrom', { name: nameOf(v.customerId), value: v.value })}
                  </label>
                ))}
                <label>
                  <input type="radio" name={`conf-${c.field}`} checked={choice?.mode === 'custom'} onChange={() => setField(c.field, { mode: 'custom', value: choice?.mode === 'custom' ? choice.value : '' })} />
                  {ct('identity.custom')}
                  {choice?.mode === 'custom' && <input type="text" aria-label={ct('identity.custom')} value={choice.value} onInput={(e) => setField(c.field, { mode: 'custom', value: (e.target as HTMLInputElement).value })} />}
                </label>
              </div>
            );
          })}
          <label class="care-keep-all">
            <input type="checkbox" checked={choices.keepTargetForUnresolved} onChange={() => onChoices({ ...choices, keepTargetForUnresolved: !choices.keepTargetForUnresolved })} data-testid="care-keep-target-all" />
            {ct('identity.keepTargetForRest')}
          </label>
        </fieldset>
      )}
      {preview.profileConflicts.length > 0 && <p class="care-faint">{ct('identity.profileConflicts', { n: preview.profileConflicts.length })}</p>}
    </div>
  );
}
