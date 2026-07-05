import type { IStorageAdapter } from '../types.js';
import type { Message, OutboundMessage, MessageStatus } from '../types.js';
import {
  MESSAGE_PAGE_SIZE,
  HEARTBEAT_INTERVAL_MS,
} from '../types.js';

const STORE_PREFIX = 'chat';

export const StoreKeys = {
  messages: (conversationId: string) => `${STORE_PREFIX}:messages:${conversationId}`,
  outbox: `${STORE_PREFIX}:outbox`,
  topicCache: `${STORE_PREFIX}:topic_cache`,
  typingState: `${STORE_PREFIX}:typing_state`,
  lastSequence: `${STORE_PREFIX}:last_sequence`,
  eventSequence: (userId: string) => `${STORE_PREFIX}:event_seq:${userId}`,
};

export class ChatStore {
  private storage: IStorageAdapter;
  private messagesCache: Map<string, Message[]>;
  private outboxCache: OutboundMessage[];
  private topicCache: Record<string, string>;
  private typingTimer: ReturnType<typeof setTimeout> | null;
  private typedKeys: Set<string>;

  constructor(storage: IStorageAdapter) {
    this.storage = storage;
    this.messagesCache = new Map();
    this.outboxCache = [];
    this.topicCache = {};
    this.typingTimer = null;
    this.typedKeys = new Set();
  }

  /* ── Persistence ────────────────────────────────── */

  async load(): Promise<void> {
    try {
      const outboxRaw = await this.storage.get(StoreKeys.outbox);
      if (outboxRaw) this.outboxCache = JSON.parse(outboxRaw);

      const topicRaw = await this.storage.get(StoreKeys.topicCache);
      if (topicRaw) this.topicCache = JSON.parse(topicRaw);
    } catch {
      this.outboxCache = [];
      this.topicCache = {};
    }
  }

  private async persistOutbox(): Promise<void> {
    await this.storage.set(StoreKeys.outbox, JSON.stringify(this.outboxCache));
  }

  private async persistTopicCache(): Promise<void> {
    await this.storage.set(StoreKeys.topicCache, JSON.stringify(this.topicCache));
  }

  /* ── Messages ───────────────────────────────────── */

  async getMessages(conversationId: string): Promise<Message[]> {
    const cached = this.messagesCache.get(conversationId);
    if (cached) {
      return cached;
    }
    const raw = await this.storage.get(StoreKeys.messages(conversationId));
    const msgs: Message[] = raw ? JSON.parse(raw) : [];
    this.messagesCache.set(conversationId, msgs);
    return msgs;
  }

  async upsertMessage(conversationId: string, msg: Message): Promise<void> {
    const msgs = await this.getMessages(conversationId);
    const idx = msgs.findIndex(
      (m) => m.id === msg.id || m.localId === msg.localId,
    );
    if (idx >= 0) {
      msgs[idx] = { ...msgs[idx], ...msg };
    } else {
      msgs.push(msg);
    }
    await this.persistMessages(conversationId, msgs);
  }

  async updateMessageStatus(
    conversationId: string,
    localId: string,
    status: MessageStatus,
    serverId?: string,
  ): Promise<void> {
    const msgs = await this.getMessages(conversationId);
    const msg = msgs.find((m) => m.localId === localId);
    if (!msg) return;
    msg.status = status;
    if (serverId) msg.id = serverId;
    if (status === 'sent') msg.sentAt = new Date().toISOString();
    await this.persistMessages(conversationId, msgs);
  }

  async addMessages(conversationId: string, newMsgs: Message[]): Promise<void> {
    const msgs = await this.getMessages(conversationId);
    const ids = new Set(msgs.map((m) => m.id));
    const localIds = new Set(msgs.map((m) => m.localId));
    const deduped = newMsgs.filter(
      (m) => !ids.has(m.id) && !localIds.has(m.localId),
    );
    if (deduped.length === 0) return;
    msgs.push(...deduped);
    await this.persistMessages(conversationId, msgs);
  }

  async markMessagesRead(conversationId: string, readerId: string): Promise<void> {
    const msgs = await this.getMessages(conversationId);
    let changed = false;
    for (const msg of msgs) {
      if (msg.senderId !== readerId && msg.status !== 'read') {
        msg.status = 'read';
        msg.readAt = new Date().toISOString();
        changed = true;
      }
    }
    if (changed) {
      await this.persistMessages(conversationId, msgs);
    }
  }

  async markMessagesDelivered(conversationId: string, userId: string): Promise<void> {
    const msgs = await this.getMessages(conversationId);
    let changed = false;
    for (const msg of msgs) {
      if (msg.senderId !== userId && msg.status === 'sent') {
        msg.status = 'delivered';
        msg.deliveredAt = new Date().toISOString();
        changed = true;
      }
    }
    if (changed) {
      await this.persistMessages(conversationId, msgs);
    }
  }

  async clearConversation(conversationId: string): Promise<void> {
    this.messagesCache.delete(conversationId);
    await this.storage.remove(StoreKeys.messages(conversationId));
  }

  private async persistMessages(
    conversationId: string,
    msgs: Message[],
  ): Promise<void> {
    this.messagesCache.set(conversationId, msgs);
    await this.storage.set(
      StoreKeys.messages(conversationId),
      JSON.stringify(msgs),
    );
  }

  /* ── Outbox ─────────────────────────────────────── */

  getPendingOutbox(): OutboundMessage[] {
    return this.outboxCache.filter((m) => m.status !== 'sent');
  }

  async addToOutbox(msg: OutboundMessage): Promise<void> {
    this.outboxCache.push(msg);
    await this.persistOutbox();
  }

  async updateOutboxStatus(
    outboxId: string,
    status: OutboundMessage['status'],
  ): Promise<void> {
    const msg = this.outboxCache.find((m) => m.id === outboxId);
    if (!msg) return;
    msg.status = status;
    await this.persistOutbox();
  }

  async removeFromOutbox(outboxId: string): Promise<void> {
    this.outboxCache = this.outboxCache.filter((m) => m.id !== outboxId);
    await this.persistOutbox();
  }

  async flushOldOutboxEntries(maxAgeMs: number = 86_400_000): Promise<void> {
    const cutoff = Date.now() - maxAgeMs;
    this.outboxCache = this.outboxCache.filter((m) => m.queuedAt > cutoff);
    await this.persistOutbox();
  }

  /* ── Topic → ConversationId cache ────────────────── */

  getConversationId(topic: string): string | undefined {
    return this.topicCache[topic];
  }

  async cacheConversationId(
    topic: string,
    conversationId: string,
  ): Promise<void> {
    this.topicCache[topic] = conversationId;
    await this.persistTopicCache();
  }

  /* ── Typing state ───────────────────────────────── */

  onTypingReceived(topic: string, userId: string): void {
    this.typedKeys.add(`${topic}:${userId}`);
    if (this.typingTimer) clearTimeout(this.typingTimer);
    this.typingTimer = setTimeout(() => {
      this.typedKeys.clear();
    }, HEARTBEAT_INTERVAL_MS * 2);
  }

  isUserTyping(topic: string, userId: string): boolean {
    return this.typedKeys.has(`${topic}:${userId}`);
  }

  /* ── Sequence tracking (events channel) ──────────── */

  async getLastEventSequence(userId: string): Promise<number> {
    const raw = await this.storage.get(StoreKeys.eventSequence(userId));
    return raw ? parseInt(raw, 10) : 0;
  }

  async saveLastEventSequence(
    userId: string,
    sequence: number,
  ): Promise<void> {
    await this.storage.set(
      StoreKeys.eventSequence(userId),
      String(sequence),
    );
  }

  /* ── Dispose ────────────────────────────────────── */

  dispose(): void {
    this.messagesCache.clear();
    this.outboxCache = [];
    this.topicCache = {};
    if (this.typingTimer) clearTimeout(this.typingTimer);
  }
}
