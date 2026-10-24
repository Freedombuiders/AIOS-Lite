/** Display title of a conversation: the stored title, trimmed. Channel modules may store `chat · topic`; only the first part is the title. */
export function conversationTitle(title: string | null | undefined): string {
  const t = (title ?? '').trim();
  return t.split(' · ')[0] ?? t;
}
