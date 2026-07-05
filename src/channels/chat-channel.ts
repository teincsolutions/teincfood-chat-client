import type { PhoenixV2Frame, Message, SendResult, JoinResult, TypingData, MessagesReadData, MessagesDeliveredData, PresenceData, ChatClientConfig } from '../types.js';
import { PhoenixSocket } from '../phoenix-socket.js';
import { ChatStore } from '../store/store.js';
import { normalizeMessagePayload, generateLocalId } from '../message-service.js';

type MessageCallback = (msg: Message) => void;
type TypingCallback = (data: TypingData) => void;
type JoinCallback = (result: JoinResult) => void;
type ReadReceiptCallback = (data: MessagesReadData) => void;
type DeliveryCallback = (data: MessagesDeliveredData) => void;
type PresenceCallback = (data: PresenceData) => void;

export class ChatChannel {
  private socket: PhoenixSocket;
  private store: ChatStore;
  private topic: string;
  private messagePageSize: number;
  private onMessageCallbacks: Set<MessageCallback> = new Set();
  private onTypingCallbacks: Set<TypingCallback> = new Set();
  private onJoinCallbacks: Set<JoinCallback> = new Set();
  private onReadReceiptCallbacks: Set<ReadReceiptCallback> = new Set();
  private onDeliveryCallbacks: Set<DeliveryCallback> = new Set();
  private onPresenceCallbacks: Set<PresenceCallback> = new Set();
  private _presenceState: PresenceData = {};
  private frameUnsub: (() => void) | null = null;
  private _isReady = false;
  private _conversationId: string | null = null;

  constructor(socket: PhoenixSocket, store: ChatStore, topic: string, messagePageSize = 50) {
    this.socket = socket;
    this.store = store;
    this.topic = topic;
    this.messagePageSize = messagePageSize;
  }

  get isReady(): boolean {
    return this._isReady;
  }

  get conversationId(): string | null {
    return this._conversationId;
  }

  get topicName(): string {
    return this.topic;
  }

  async join(
    joinPayload: Record<string, unknown> = {},
  ): Promise<JoinResult> {
    const response = await this.socket.joinChannel(this.topic, joinPayload);
    const convId = (response.conversation_id as string) ?? null;

    this._conversationId = convId;
    if (convId) {
      await this.store.cacheConversationId(this.topic, convId);
    }

    this.startListening();
    this._isReady = true;

    this.notifyJoin({ topic: this.topic, conversationId: convId ?? undefined });
    return { topic: this.topic, conversationId: convId ?? undefined };
  }

  leave(): void {
    this.stopListening();
    this._isReady = false;
    this._conversationId = null;
    this.socket.leaveChannel(this.topic);
    this.onMessageCallbacks.clear();
    this.onTypingCallbacks.clear();
    this.onJoinCallbacks.clear();
    this.onReadReceiptCallbacks.clear();
    this.onDeliveryCallbacks.clear();
    this.onPresenceCallbacks.clear();
  }

  private startListening(): void {
    if (this.frameUnsub) return;
    this.frameUnsub = this.socket.onFrame(this.topic, (frame) => {
      this.handleFrame(frame);
    });
  }

  private stopListening(): void {
    if (this.frameUnsub) {
      this.frameUnsub();
      this.frameUnsub = null;
    }
  }

  private handleFrame([_joinRef, _ref, _topic, event, payload]: PhoenixV2Frame): void {
    if (event === 'new_message') {
      const raw = payload as Record<string, unknown>;
      const msg = normalizeMessagePayload(raw, this._conversationId ?? '');
      this.onMessageCallbacks.forEach((cb) => cb(msg));
    } else if (event === 'typing') {
      const data = payload as { sender_id?: string; is_typing?: boolean };
      this.onTypingCallbacks.forEach((cb) =>
        cb({
          senderId: data.sender_id ?? '',
          isTyping: data.is_typing ?? false,
        }),
      );
    } else if (event === 'messages_read') {
      const data = payload as Record<string, unknown>;
      const readData: MessagesReadData = {
        conversationId: (data.conversation_id as string) ?? '',
        readerId: (data.reader_id as string) ?? '',
        readAt: (data.read_at as string) ?? '',
      };
      this.store.markMessagesRead(readData.conversationId, readData.readerId);
      this.onReadReceiptCallbacks.forEach((cb) => cb(readData));
    } else if (event === 'messages_delivered') {
      const data = payload as Record<string, unknown>;
      const deliveredData: MessagesDeliveredData = {
        conversationId: (data.conversation_id as string) ?? '',
        userId: (data.user_id as string) ?? '',
        deliveredAt: (data.delivered_at as string) ?? '',
      };
      this.store.markMessagesDelivered(deliveredData.conversationId, deliveredData.userId);
      this.onDeliveryCallbacks.forEach((cb) => cb(deliveredData));
    } else if (event === 'presence_state' || event === 'presence_diff') {
      const data = payload as PresenceData;
      if (event === 'presence_state') {
        this._presenceState = data;
      } else {
        this._presenceState = { ...this._presenceState, ...data };
      }
      this.onPresenceCallbacks.forEach((cb) => cb(data));
    }
  }

  async sendMessage(
    text: string,
    options?: { targetUserId?: string },
  ): Promise<SendResult> {
    const localId = generateLocalId();
    const conversationId =
      this._conversationId ?? this.store.getConversationId(this.topic) ?? this.topic;

    const optimistic: Message = {
      id: localId,
      localId,
      conversationId,
      senderId: 'pending',
      text,
      status: 'sending',
      channel: 'app',
      messageType: 'text',
      sentAt: new Date().toISOString(),
    };

    await this.store.upsertMessage(conversationId, optimistic);

    const payload: Record<string, unknown> = {
      body: text,
      message: text,
      client_message_id: localId,
    };
    if (options?.targetUserId) {
      payload.target_user_id = options.targetUserId;
    }

    try {
      const response = await this.socket.pushWithReply(
        this.topic,
        'new_message',
        payload,
      );

      const serverId = (response.id as string) ?? localId;
      await this.store.updateMessageStatus(conversationId, localId, 'sent', serverId);
      return { localId, serverId, status: 'sent' };
    } catch {
      await this.store.updateMessageStatus(conversationId, localId, 'failed');
      await this.store.addToOutbox({
        id: localId,
        topic: this.topic,
        conversationId,
        text,
        status: 'queued',
        queuedAt: Date.now(),
      });
      return { localId, status: 'failed' };
    }
  }

  sendTyping(isTyping: boolean): void {
    this.socket.push(this.topic, 'typing', { is_typing: isTyping });
  }

  markRead(): void {
    this.socket.push(this.topic, 'mark_read', {});
  }

  getPresenceState(): PresenceData {
    return this._presenceState;
  }

  async loadHistory(limit?: number, offset = 0): Promise<Message[]> {
    const conversationId =
      this._conversationId ?? this.store.getConversationId(this.topic) ?? this.topic;

    try {
      const response = await this.socket.pushWithReply(this.topic, 'get_messages', {
        limit: limit ?? this.messagePageSize,
        offset,
      });

      const rawMessages = (response.messages as Array<Record<string, unknown>>) ?? [];
      const messages = rawMessages.map((raw) =>
        normalizeMessagePayload(raw, conversationId),
      );

      await this.store.addMessages(conversationId, messages);
      return messages;
    } catch {
      return [];
    }
  }

  onMessage(cb: MessageCallback): () => void {
    this.onMessageCallbacks.add(cb);
    return () => {
      this.onMessageCallbacks.delete(cb);
    };
  }

  onTyping(cb: TypingCallback): () => void {
    this.onTypingCallbacks.add(cb);
    return () => {
      this.onTypingCallbacks.delete(cb);
    };
  }

  onJoin(cb: JoinCallback): () => void {
    this.onJoinCallbacks.add(cb);
    return () => {
      this.onJoinCallbacks.delete(cb);
    };
  }

  onReadReceipt(cb: ReadReceiptCallback): () => void {
    this.onReadReceiptCallbacks.add(cb);
    return () => {
      this.onReadReceiptCallbacks.delete(cb);
    };
  }

  onDelivered(cb: DeliveryCallback): () => void {
    this.onDeliveryCallbacks.add(cb);
    return () => {
      this.onDeliveryCallbacks.delete(cb);
    };
  }

  onPresence(cb: PresenceCallback): () => void {
    this.onPresenceCallbacks.add(cb);
    return () => {
      this.onPresenceCallbacks.delete(cb);
    };
  }

  private notifyJoin(result: JoinResult): void {
    this.onJoinCallbacks.forEach((cb) => cb(result));
  }

  async flushOutbox(): Promise<void> {
    const pending = this.store.getPendingOutbox().filter((m) => m.topic === this.topic);
    for (const msg of pending) {
      await this.store.updateOutboxStatus(msg.id, 'sending');
      try {
        const response = await this.socket.pushWithReply(this.topic, 'new_message', {
          body: msg.text,
          message: msg.text,
          client_message_id: msg.id,
        });
        const serverId = (response.id as string) ?? msg.id;
        await this.store.updateMessageStatus(msg.conversationId, msg.id, 'sent', serverId);
        await this.store.removeFromOutbox(msg.id);
      } catch {
        await this.store.updateOutboxStatus(msg.id, 'failed');
      }
    }
  }
}


