// Synthetic fixtures for Care web tests. No real names, addresses or credentials.
import type { CareConversationDto, CareMessageDto } from './dto';

export function conv(over: Partial<CareConversationDto> = {}): CareConversationDto {
  return {
    id: 'c1', accountId: 'a1', channel: 'zalo', kind: 'direct', title: 'Khách A', status: 'active', primaryCustomerId: null,
    isPaused: false, pausedUntilMs: null, isOptedOut: false, waitingSinceMs: null, remoteUnreadCount: 0, localSeenMessageId: null,
    localUnread: false, lastMessageId: null, lastMessagePreview: null, lastActivityMs: 1000, revision: 1, ...over,
  };
}

export function msg(over: Partial<CareMessageDto> = {}): CareMessageDto {
  return {
    id: 'm1', conversationId: 'c1', accountId: 'a1', nativeMessageId: 'n1', direction: 'in', senderRole: 'customer', senderIdentityId: null, senderName: null,
    text: 'xin chào', metadata: { type: 'chat' }, origin: 'live', sentAtMs: 1000, nativeVersion: null, deleted: false, deletedAtMs: null, ...over,
  };
}

export function emailMsg(over: Partial<CareMessageDto> & { meta?: Record<string, unknown> } = {}): CareMessageDto {
  const { meta, ...rest } = over;
  return msg({
    id: 'e1', direction: 'in', senderRole: 'customer', text: 'Nội dung thư',
    metadata: {
      type: 'email', subject: 'Báo giá lô hàng', from: 'khach@example.test', to: ['sale@shop.test', 'ketoan@shop.test'], cc: ['sep@khach.test'],
      messageIdHeader: '<abc@mail.example.test>', ...(meta ?? {}),
    },
    ...rest,
  });
}
