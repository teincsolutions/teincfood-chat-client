import { ChatStore } from './store/store.js';
import type { Message, OutboundMessage, MessageStatus } from './types.js';

const LOCAL_ID_PREFIX = 'msg';

export function generateLocalId(): string {
  return `${LOCAL_ID_PREFIX}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export function normalizeMessagePayload(
  raw: Record<string, unknown>,
  conversationId: string,
): Message {
  const id = (raw.id as string) ?? '';
  return {
    id,
    localId: (raw.client_message_id as string) ?? id,
    conversationId: (raw.conversation_id as string) ?? conversationId,
    senderId: (raw.sender_id ?? raw.user_id ?? '') as string,
    text: (raw.content ?? raw.text ?? '') as string,
    status: (raw.status as MessageStatus) ?? 'delivered',
    channel: (raw.channel as Message['channel']) ?? 'app',
    messageType: (raw.message_type as Message['messageType']) ?? 'text',
    sentAt: (raw.sent_at ?? raw.inserted_at ?? new Date().toISOString()) as string,
    metadata: raw.metadata as Record<string, unknown> | undefined,
  };
}

export class MessageService {
  private store: ChatStore;

  constructor(store: ChatStore) {
    this.store = store;
  }

  async addOptimisticMessage(
    conversationId: string,
    text: string,
    topic: string,
    senderId?: string,
  ): Promise<Message> {
    const localId = generateLocalId();
    const msg: Message = {
      id: localId,
      localId,
      conversationId,
      senderId: senderId ?? 'pending',
      text,
      status: 'sending',
      channel: 'app',
      messageType: 'text',
      sentAt: new Date().toISOString(),
    };
    await this.store.upsertMessage(conversationId, msg);
    return msg;
  }

  async confirmMessage(
    conversationId: string,
    localId: string,
    serverId: string,
  ): Promise<void> {
    await this.store.updateMessageStatus(
      conversationId,
      localId,
      'sent',
      serverId,
    );
  }

  async failMessage(
    conversationId: string,
    localId: string,
    topic: string,
    text: string,
  ): Promise<void> {
    await this.store.updateMessageStatus(conversationId, localId, 'failed');
    await this.store.addToOutbox({
      id: localId,
      topic,
      conversationId,
      text,
      status: 'queued',
      queuedAt: Date.now(),
    });
  }

  async reconcilePreJoinMessages(
    topic: string,
    conversationId: string,
  ): Promise<void> {
    const fallbackMsgs = await this.store.getMessages(topic);
    const realMsgs = await this.store.getMessages(conversationId);

    const ids = new Set(realMsgs.map((m) => m.id));
    const localIds = new Set(realMsgs.map((m) => m.localId));

    const toMove = fallbackMsgs.filter(
      (m) => !ids.has(m.id) && !localIds.has(m.localId),
    );
    if (toMove.length === 0) {
      await this.store.clearConversation(topic);
      return;
    }

    const moved = toMove.map((m) => ({
      ...m,
      conversationId,
    }));
    await this.store.addMessages(conversationId, moved);
    await this.store.clearConversation(topic);
  }
}
