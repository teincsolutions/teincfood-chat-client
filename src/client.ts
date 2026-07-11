import type {
  AuthTokens,
  ChatClientOptions,
  ChatEventName,
  ChatEventMap,
  Contact,
  ContactContext,
  Conversation,
  Message,
  TempMessage,
  MessageListMeta,
  PushEventResult,
} from "./types"
import { TypedEventEmitter } from "./events"
import { HttpClient } from "./http"
import { ChatStore } from "./store"
import { OptimisticEngine } from "./optimistic"
import { PhoenixChatSocket, toMessage, toConversation } from "./socket"
import { createAuthApi } from "./api/auth"
import { createConversationsApi } from "./api/conversations"
import { createMessagesApi } from "./api/messages"
import { createContactsApi } from "./api/contacts"
import { createNotificationsApi } from "./api/notifications"
import { createUploadApi } from "./api/upload"
import { retry } from "./retry"

export class ChatClient {
  // Sub-APIs
  readonly auth: ReturnType<typeof createAuthApi>
  readonly conversations: ReturnType<typeof createConversationsApi>
  readonly messages: ReturnType<typeof createMessagesApi>
  readonly contacts: ReturnType<typeof createContactsApi>
  readonly notifications: ReturnType<typeof createNotificationsApi>
  readonly upload: ReturnType<typeof createUploadApi>

  // Internals
  readonly store: ChatStore
  readonly emitter: TypedEventEmitter

  private http: HttpClient
  private optimistic: OptimisticEngine
  private socket: PhoenixChatSocket
  private tokens: AuthTokens | null = null
  private currentUserId: string | null = null
  constructor(opts: ChatClientOptions) {
    this.store = new ChatStore(opts.storage)
    this.emitter = new TypedEventEmitter()
    this.optimistic = new OptimisticEngine(this.emitter)

    this.http = new HttpClient({
      baseUrl: opts.baseUrl,
      getTokens: () => this.tokens,
      setTokens: (t) => {
        this.tokens = t
      },
      onTokenExpired: opts.onTokenExpired,
      emitter: this.emitter,
    })

    this.socket = new PhoenixChatSocket(
      opts.wsUrl,
      this.emitter,
      this.optimistic,
      this.store,
    )

    this.auth = createAuthApi(this.http)
    this.conversations = createConversationsApi(this.http)
    this.messages = createMessagesApi(this.http)
    this.contacts = createContactsApi(this.http)
    this.notifications = createNotificationsApi(this.http)
    this.upload = createUploadApi(this.http)
  }

  // ─── Lifecycle ────────────────────────────────────

  /** Hydrate cached data from storage and connect the WebSocket. */
  async start(tokens: AuthTokens): Promise<void> {
    this.tokens = tokens
    await this.store.hydrate()
    try {
      await this.socket.connect(tokens.access_token)
      // Auto-join the events channel for live updates
      if (this.currentUserId) {
        await this.socket.joinEventsChannel(this.currentUserId).catch(() => {})
      }
    } catch {
      // WS is optional — REST calls still work
    }
  }

  /** Disconnect WebSocket and clear all listeners. */
  stop(): void {
    this.socket.leaveEventsChannel()
    this.socket.disconnect()
    this.optimistic.clear()
    this.emitter.removeAllListeners()
  }

  /** Fully clear local cache. */
  async clearCache(): Promise<void> {
    this.store.clear()
  }

  // ─── Token management ─────────────────────────────

  getTokens(): AuthTokens | null {
    return this.tokens
  }

  setTokens(tokens: AuthTokens | null): void {
    this.tokens = tokens
  }

  setCurrentUserId(userId: string): void {
    this.currentUserId = userId
    // Auto-join events channel if socket already connected
    if (this.socket.isConnected()) {
      this.socket.joinEventsChannel(userId).catch(() => {})
    }
  }

  getCurrentUserId(): string | null {
    return this.currentUserId
  }

  /** Check if the WebSocket is currently connected. */
  isConnected(): boolean {
    return this.socket.isConnected()
  }

  /** Return optimistic messages not yet confirmed by the server. */
  getPendingMessages(conversationId: string): TempMessage[] {
    return this.optimistic.getPending(conversationId)
  }

  // ─── WebSocket channel management ─────────────────

  /** Join a conversation channel to receive live updates. */
  async joinConversation(conversationId: string): Promise<void> {
    await this.socket.joinConversation(conversationId)
  }

  /** Leave a conversation channel. */
  leaveConversation(conversationId: string): void {
    this.socket.leaveConversation(conversationId)
  }

  // ─── Sending messages (optimistic) ────────────────

  /**
   * Send a text message with optimistic UI.
   * Must be joined to the conversation's WebSocket channel first.
   * Returns the temp message immediately; reconciled when server confirms.
   */
  sendMessage(
    conversationId: string,
    body: string,
    metadata?: Record<string, unknown> | null,
  ): TempMessage {
    const senderId = this.currentUserId ?? "unknown"

    // Create optimistic message (not stored — useChat merges pending + stored)
    const temp = this.optimistic.create(conversationId, senderId, body, metadata)

    if (!this.socket.isJoined(conversationId)) {
      console.warn(
        `[chat-client] Not joined to chat:${conversationId}, cannot send`,
      )
      temp.status = "failed"
      this.emitter.emit("message:failed", temp)
      return temp
    }

    // Send via WebSocket (with retry)
    retry(() => {
      this.socket.sendMessage(conversationId, body, metadata)
      return Promise.resolve()
    }).catch(() => {
      temp.status = "failed"
      this.emitter.emit("message:failed", temp)
    })

    return temp
  }

  // ─── Other real-time actions ──────────────────────

  sendTyping(conversationId: string): void {
    this.socket.sendTyping(conversationId)
  }

  markRead(conversationId: string): void {
    this.socket.markRead(conversationId)
  }

  /** Fetch message history via WebSocket. */
  fetchMessages(conversationId: string, limit?: number): void {
    this.socket.fetchMessages(conversationId, limit)
  }

  // ─── REST helpers ─────────────────────────────────

  /** Fetch inbox then cache it. */
  async loadInbox(): Promise<Conversation[]> {
    const convs = await this.conversations.getInbox()
    this.store.setConversations(convs)
    return convs
  }

  /** Fetch contacts then cache them. */
  async loadContacts(
    context?: ContactContext,
    businessId?: string,
    q?: string,
  ): Promise<Contact[]> {
    const result = await this.contacts.getContacts(context, businessId, q)
    this.store.setContacts(result)
    return result
  }

  /** Get messages from REST (falls back when WebSocket response unreliable). */
  async loadMessages(
    conversationId: string,
    limit = 50,
    offset = 0,
  ): Promise<{ data: Message[]; meta: MessageListMeta }> {
    const result = await this.messages.list(conversationId, limit, offset)
    if (offset === 0) {
      this.store.setMessages(conversationId, result.data)
    } else {
      for (const m of result.data) {
        this.store.upsertMessage(conversationId, m)
      }
    }
    return result
  }

  // ─── Background push notification handling ─────────

  /**
   * Process a remote push notification payload outside the WebSocket.
   *
   * On mobile platforms the WS connection is killed when the app goes to
   * background. Push notifications carry the event data directly. This
   * method routes the payload through the same store + event logic as the
   * live events channel, so the UI updates even without a WS connection.
   *
   * The returned `sequence` (if present) is tracked internally so that
   * when the WS reconnects and the events channel is re-joined, the
   * `last_sequence` parameter prevents duplicate event delivery.
   *
   * Usage with React Native background push:
   * ```ts
   * // In your push notification handler:
   * const result = chatClient.handlePushPayload(notification.data)
   * if (result.handled) {
   *   // Optional: trigger a local notification or update badge
   * }
   * ```
   */
  handlePushPayload(payload: Record<string, unknown>): PushEventResult {
    const event = payload.event as string | undefined
    if (!event) return { handled: false }

    const seq = payload._sequence as number | undefined
    if (typeof seq === "number") {
      this.socket.setLastSequence(seq)
    }

    switch (event) {
      case "new_message": {
        const raw = (payload.message ?? payload) as Record<string, unknown>
        const msg = toMessage(raw)
        this.store.upsertMessage(msg.conversation_id, msg)
        this.emitter.emit("message:received", msg)
        return { handled: true, event: "message:received", data: raw, sequence: seq }
      }
      case "conversation:created": {
        const raw = (payload.conversation ?? payload) as Record<string, unknown>
        const conv = toConversation(raw)
        this.store.upsertConversation(conv)
        this.emitter.emit("conversation:created", { conversation: conv })
        return { handled: true, event: "conversation:created", data: raw, sequence: seq }
      }
      case "conversation:updated": {
        const raw = (payload.conversation ?? payload) as Record<string, unknown>
        const conv = toConversation(raw)
        this.store.upsertConversation(conv)
        this.emitter.emit("conversation:updated", { conversation: conv })
        return { handled: true, event: "conversation:updated", data: raw, sequence: seq }
      }
      case "messages_read": {
        this.store.markConversationRead(
          payload.conversation_id as string,
          payload.reader_id as string,
        )
        this.emitter.emit("messages_read", {
          conversationId: payload.conversation_id as string,
          userId: payload.reader_id as string,
          readAt: payload.read_at as string,
        })
        return { handled: true, event: "messages_read", data: payload as any, sequence: seq }
      }
      case "messages_delivered": {
        this.emitter.emit("messages_delivered", {
          conversationId: payload.conversation_id as string,
          userId: payload.user_id as string,
        })
        return { handled: true, event: "messages_delivered", data: payload as any, sequence: seq }
      }
      case "unread_count": {
        this.store.setUnreadCount(
          payload.conversation_id as string,
          payload.unread_count as number,
        )
        this.emitter.emit("unread_count", {
          conversationId: payload.conversation_id as string,
          unread_count: payload.unread_count as number,
        })
        return { handled: true, event: "unread_count", data: payload as any, sequence: seq }
      }
      default:
        return { handled: false }
    }
  }

  // ─── Event subscriptions ──────────────────────────

  on<E extends ChatEventName>(
    event: E,
    listener: ChatEventMap[E],
  ): () => void {
    return this.emitter.on(event, listener)
  }

  off<E extends ChatEventName>(
    event: E,
    listener: ChatEventMap[E],
  ): void {
    this.emitter.off(event, listener)
  }
}
