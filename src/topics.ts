export function getChatTopic(conversationId: string): string {
  return `chat:${conversationId}`;
}

export function getEventsTopic(userId: string): string {
  return `events:${userId}`;
}

export function buildSupportChannelUrl(
  baseUrl: string,
  token: string,
  userId: string,
): string {
  const base = baseUrl.replace(/\/+$/, '');
  const path = base.endsWith('/websocket') ? '' : '/websocket';
  return `${base}${path}?token=${encodeURIComponent(token)}&vsn=2.0.0`;
}
