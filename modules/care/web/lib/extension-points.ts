// Extension points the care module renders. Channel modules (zalo, gmail, ...) provide components under these keys in
// their own web entry:  defineWebModule({ id: 'zalo', provides: { 'care.channelPanel': ZaloPanel } }).
// Care collects them with `useProvides(key)` from '@/module-host' and renders every provided component; each component
// decides from `props.channel` whether it applies and returns null otherwise. With no provider, nothing is rendered.
//
//   'care.channelPanel'     -> ComponentType<CareChannelPanelProps>
//       Rendered inside an account card of "Kênh & agent" (/m/care/channels): channel-specific settings, login,
//       anti-ban numbers, and so on.
//         { channel: string,          // 'zalo' | 'email' | ... (the care channel id of the account)
//           account: CareAccountDto,  // the care account the card is for
//           onChanged?: () => void }  // call after a change so care reloads its account list
//
//   'care.composerExtras'   -> ComponentType<CareComposerExtrasProps>
//       Rendered in the action row of the reply box (attachment picker, templates, ...).
//         { channel: string,
//           account?: CareAccountDto,
//           thread: CareConversationDto,   // the open conversation
//           disabled: boolean,             // sending is blocked right now
//           attachments: ChatAttachment[], // attachments of the current draft
//           onAttachmentsChange: (next: ChatAttachment[]) => void }

import type { ComponentType } from 'preact';
import type { ChatAttachment } from './care/composer';
import type { CareAccountDto, CareConversationDto } from './care/dto';

export interface CareChannelPanelProps {
  channel: string;
  accountId?: string;
  account: CareAccountDto;
  onChanged?: () => void;
}

export interface CareComposerExtrasProps {
  channel: string;
  threadId: string;
  account?: CareAccountDto;
  thread: CareConversationDto;
  disabled: boolean;
  attachments: ChatAttachment[];
  onAttachmentsChange: (next: ChatAttachment[]) => void;
}

export type CareChannelPanelComponent = ComponentType<CareChannelPanelProps>;
export type CareComposerExtrasComponent = ComponentType<CareComposerExtrasProps>;

export const CHANNEL_PANEL_KEY = 'care.channelPanel';
export const COMPOSER_EXTRAS_KEY = 'care.composerExtras';
