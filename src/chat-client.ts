import type {
  ChatClientConfig,
  ConnectionState,
  Message,
  JoinResult,
  SendResult,
  TypingData,
  OutboundMessage,
  MessagesReadData,
  MessagesDeliveredData,
  PresenceData,
} from './types.js';
import { PhoenixSocket } from './phoenix-socket.js';
import { ChatStore } from './store/store.js';
import { ChatChannel } from './channels/chat-channel.js';
import { EventsChannel } from './channels/events-channel.js';
import { getChatTopic } from './topics.js';
import { MessageService } from './message-service.js';
import { ConversationService } from './conversation-service.js';

type GenericCallback<T = unknown> = (data: T) => void;
type Unsubscribe = () => void;

interface ChatClientEvents {
  message: GenericCallback<Message>;
  typing: GenericCallback<TypingData>;
  connection: GenericCallback<ConnectionState>;
  error: GenericCallback<Error>;
  join: GenericCallback<JoinResult>;
  outbox: GenericCallback<OutboundMessage[]>;
  read_receipt: GenericCallback<MessagesReadData>;
  delivery_receipt: GenericCallback<MessagesDeliveredData>;
  presence: GenericCallback<PresenceData>;
}

export class ChatClient {
  readonly socket: PhoenixSocket;
  readonly store: ChatStore;
  readonly messages: MessageService;
  readonly rest: ConversationService;

  private channels: Map<string, ChatChannel> = new Map();
  private eventsChannel: EventsChannel | null = null;
  private eventListeners: Map<string, Set<GenericCallback>> = new Map();
  private connectionUnsub: (() => void) | null = null;
  private messagePageSize: number;
  private _connected = false;

  constructor(config: ChatClientConfig) {
    this.socket = new PhoenixSocket(config);
    this.store = new ChatStore(config.storage);
    this.messages = new MessageService(this.store);
    this.rest = new ConversationService(config);
    this.messagePageSize = config.messagePageSize ?? 50;

    this.connectionUnsub = this.socket.onConnectionStateChange(
      (state, _prev) => {
        this._connected = state === 'connected';
        this.emit('connection', state);
        if (state === 'connected') {
          this.flushAllOutboxes().catch(() => {});
        }
      },
    );
  }

  /* ── Lifecycle ─────────────────────────────────── */

  async connect(): Promise<void> {
    await this.store.load();
    await this.socket.connect();
  }

  disconnect(): void {
    this.channels.forEach((ch) => ch.leave());
    this.channels.clear();
    if (this.eventsChannel) {
      this.eventsChannel.disconnect();
      this.eventsChannel = null;
    }
    if (this.connectionUnsub) {
      this.connectionUnsub();
      this.connectionUnsub = null;
    }
    this.socket.disconnect();
    this.store.dispose();
  }

  retryConnection(): void {
    this.socket.retryConnection();
  }

  get connectionState(): ConnectionState {
    return this.socket.getConnectionState();
  }

  get isConnected(): boolean {
    return this._connected;
  }

  /* ── Events ────────────────────────────────────── */

  on<E extends keyof ChatClientEvents>(
    event: E,
    callback: ChatClientEvents[E],
  ): Unsubscribe;
  on(event: string, callback: GenericCallback): Unsubscribe {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, new Set());
    }
    this.eventListeners.get(event)!.add(callback);
    return () => {
      this.eventListeners.get(event)?.delete(callback);
    };
  }

  off<E extends keyof ChatClientEvents>(
    event: E,
    callback: ChatClientEvents[E],
  ): void;
  off(event: string, callback: GenericCallback): void {
    this.eventListeners.get(event)?.delete(callback);
  }

  private emit(event: string, data: unknown): void {
    this.eventListeners.get(event)?.forEach((cb) => cb(data));
  }

  /* ── Chat Channels ──────────────────────────────── */

  private getOrCreateChannel(topic: string): ChatChannel {
    let ch = this.channels.get(topic);
    if (!ch) {
      ch = new ChatChannel(this.socket, this.store, topic, this.messagePageSize);
      this.channels.set(topic, ch);
    }
    return ch;
  }

  getChannel(topic: string): ChatChannel | undefined {
    return this.channels.get(topic);
  }

  hasJoined(topic: string): boolean {
    const ch = this.channels.get(topic);
    return ch ? ch.isReady : this.socket.hasJoined(topic);
  }

  async joinConversation(conversationId: string): Promise<JoinResult> {
    const topic = getChatTopic(conversationId);
    const ch = this.getOrCreateChannel(topic);
    const result = await ch.join({ conversation_id: conversationId });
    this.setupChannelEvents(ch, topic);
    await ch.flushOutbox();
    return result;
  }

  async joinCustomChat(
    topic: string,
    joinPayload?: Record<string, unknown>,
  ): Promise<JoinResult> {
    const ch = this.getOrCreateChannel(topic);
    const result = await ch.join(joinPayload);
    this.setupChannelEvents(ch, topic);
    return result;
  }

  leaveChat(topic: string): void {
    const ch = this.channels.get(topic);
    if (ch) {
      ch.leave();
      this.channels.delete(topic);
    }
  }

  private setupChannelEvents(ch: ChatChannel, topic: string): void {
    ch.onMessage((msg) => {
      this.store.upsertMessage(msg.conversationId, msg);
      this.emit('message', msg);
    });

    ch.onTyping((data) => {
      this.store.onTypingReceived(topic, data.senderId);
      this.emit('typing', data);
    });

    ch.onJoin((result) => {
      this.emit('join', result);
    });

    ch.onReadReceipt((data) => {
      this.emit('read_receipt', data);
    });

    ch.onDelivered((data) => {
      this.emit('delivery_receipt', data);
    });

    ch.onPresence((data) => {
      this.emit('presence', data);
    });
  }

  /* ── Messaging ─────────────────────────────────── */

  async sendMessage(
    topic: string,
    text: string,
    options?: { targetUserId?: string; metadata?: Record<string, unknown> },
  ): Promise<SendResult> {
    const ch = this.channels.get(topic);
    if (!ch || !ch.isReady) {
      const conversationId =
        this.store.getConversationId(topic) ?? topic;
      const optimistic = await this.messages.addOptimisticMessage(
        conversationId,
        text,
        topic,
      );
      await this.store.addToOutbox({
        id: optimistic.localId,
        topic,
        conversationId,
        text,
        status: 'queued',
        queuedAt: Date.now(),
      });
      this.emit('outbox', this.store.getPendingOutbox());
      return { localId: optimistic.localId, status: 'queued' };
    }
    return ch.sendMessage(text, options);
  }

  sendTyping(topic: string, isTyping: boolean): void {
    const ch = this.channels.get(topic);
    ch?.sendTyping(isTyping);
  }

  markRead(topic: string): void {
    const ch = this.channels.get(topic);
    ch?.markRead();
  }

  getPresence(topic: string): PresenceData {
    const ch = this.channels.get(topic);
    return ch?.getPresenceState() ?? {};
  }

  async loadHistory(
    topic: string,
    limit?: number,
    offset?: number,
  ): Promise<Message[]> {
    const ch = this.channels.get(topic);
    if (!ch) return [];
    return ch.loadHistory(limit, offset);
  }

  /* ── State Accessors ────────────────────────────── */

  async getMessages(conversationId: string): Promise<Message[]> {
    return this.store.getMessages(conversationId);
  }

  getStoredMessagesFallback(topic: string, conversationId?: string): Promise<Message[]> {
    if (conversationId) {
      return this.store.getMessages(conversationId);
    }
    return this.store.getMessages(topic);
  }

  getConversationId(topic: string): string | undefined {
    return this.store.getConversationId(topic);
  }

  getPendingOutbox(): OutboundMessage[] {
    return this.store.getPendingOutbox();
  }

  isUserTyping(topic: string, userId: string): boolean {
    return this.store.isUserTyping(topic, userId);
  }

  /* ── Events Channel ────────────────────────────── */

  async connectEventsChannel(userId: string): Promise<EventsChannel> {
    if (this.eventsChannel) {
      this.eventsChannel.disconnect();
    }
    this.eventsChannel = new EventsChannel(this.socket, this.store, userId);
    await this.eventsChannel.connect();
    return this.eventsChannel;
  }

  get events(): EventsChannel | null {
    return this.eventsChannel;
  }

  /* ── Outbox flushing (called on reconnect) ──────── */

  private async flushAllOutboxes(): Promise<void> {
    const flushTasks = Array.from(this.channels.values()).map((ch) =>
      ch.flushOutbox().catch(() => {}),
    );
    await Promise.allSettled(flushTasks);
    this.emit('outbox', this.store.getPendingOutbox());
  }
}
