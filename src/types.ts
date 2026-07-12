// ─── Message types ──────────────────────────────────────────

export type MessageDirection = "inbound" | "outbound"
export type MessageChannel = "app" | "whatsapp"
export type MessageType = "text" | "image" | "document" | "video" | "audio"
export type MessageStatus =
  | "sending"
  | "sent"
  | "delivered"
  | "read"
  | "failed"

export interface Message {
  id: string | null
  content: string
  sender_id: string
  conversation_id: string
  direction: MessageDirection
  channel: MessageChannel
  message_type: MessageType
  status: MessageStatus
  external_id: string | null
  metadata: Record<string, unknown> | null
  replied_by_id: string | null
  read: boolean
  sent_at: string
  inserted_at: string
}

/** Temp client-side ID used for optimistic reconciliation */
export interface TempMessage extends Message {
  _clientId: string
}

// ─── Conversation types ─────────────────────────────────────

export type ConversationStatus = "active" | "closed"

export interface ParticipantUser {
  id: string
  full_name: string | null
  avatar_url: string | null
}

export interface Participant {
  id: string
  user_id: string
  archived_at: string | null
  user: ParticipantUser | null
}

export interface BusinessSummary {
  id: string
  name: string
  logo_url: string | null
}

export interface Conversation {
  id: string
  status: ConversationStatus
  order_id: string | null
  business_id: string | null
  business: BusinessSummary | null
  participants: Participant[]
  messages: Message[]
  inserted_at: string
  updated_at: string
}

// ─── Contact types ──────────────────────────────────────────

export type ContactType = "user" | "business" | "member" | "rider" | "buyer"
export type ContactContext = "buyer" | "business" | "rider"

export interface Contact {
  id: string
  full_name: string | null
  avatar_url: string | null
  contact_type: ContactType
  conversation_id: string | null
  last_message: { text: string; sent_at: string } | null
  unread_count: number
}

// ─── Auth types ─────────────────────────────────────────────

export interface AuthTokens {
  access_token: string
  refresh_token: string
}

export interface LoginParams {
  email: string
  password: string
}

export interface RegisterParams {
  email: string
  password: string
  full_name: string
  phone?: string
}

export interface OtpSendParams {
  phone: string
}

export interface OtpVerifyParams {
  phone: string
  code: string
}

export interface OidcParams {
  provider: string
  code: string
  redirect_uri: string
}

// ─── Notification types ─────────────────────────────────────

export interface AppNotification {
  id: string
  user_id: string
  title: string
  body: string
  data: Record<string, unknown> | null
  read: boolean
  inserted_at: string
}

export interface PaginationMeta {
  page: number
  page_size: number
  total_entries: number
  total_pages: number
}

export interface MessageListMeta {
  limit: number
  offset: number
  count: number
}

// ─── Upload types ───────────────────────────────────────────

export interface UploadUrlResult {
  url: string
  key: string
  fields: Record<string, string>
}

// ─── Socket presence types ──────────────────────────────────

export interface PresenceUser {
  user_id: string
  online_at: number
}

// ─── Storage adapter ────────────────────────────────────────

export interface ChatStorage {
  getItem<T = unknown>(key: string): Promise<T | null>
  setItem<T = unknown>(key: string, value: T): Promise<void>
  removeItem(key: string): Promise<void>
  clear(): Promise<void>
}

export type MMKVStorage = {
  getString(key: string): string | undefined
  set(key: string, value: string): void
  delete(key: string): void
  clearAll(): void
}

export function createMMKVStorageAdapter(mmkv: MMKVStorage): ChatStorage {
  return {
    getItem: async <T>(key: string) => {
      const val = mmkv.getString(key)
      return val != null ? (JSON.parse(val) as T) : null
    },
    setItem: async (key, value) => {
      mmkv.set(key, JSON.stringify(value))
    },
    removeItem: async (key) => {
      mmkv.delete(key)
    },
    clear: async () => {
      mmkv.clearAll()
    },
  }
}

// ─── Events ─────────────────────────────────────────────────

export interface MessagesLoadedPayload {
  conversationId: string
  messages: Message[]
}

export interface TypingPayload {
  conversationId: string
  userId: string
}

export interface MessagesReadPayload {
  conversationId: string
  userId: string
  readAt: string
}

export interface MessagesDeliveredPayload {
  conversationId: string
  userId: string
}

export interface PresencePayload {
  conversationId: string
  users: PresenceUser[]
}

export interface ConversationCreatedPayload {
  conversation: Conversation
}

export interface ConversationUpdatedPayload {
  conversation: Conversation
}

export interface UnreadCountPayload {
  conversationId: string
  unread_count: number
}

export interface ChatEventMap {
  "message:sending": (msg: TempMessage) => void
  "message:sent": (msg: Message) => void
  "message:received": (msg: Message) => void
  "message:failed": (msg: TempMessage) => void
  "messages:loaded": (payload: MessagesLoadedPayload) => void
  "conversation:created": (payload: ConversationCreatedPayload) => void
  "conversation:updated": (payload: ConversationUpdatedPayload) => void
  "unread_count": (payload: UnreadCountPayload) => void
  typing: (payload: TypingPayload) => void
  messages_read: (payload: MessagesReadPayload) => void
  messages_delivered: (payload: MessagesDeliveredPayload) => void
  presence: (payload: PresencePayload) => void
  "connection:status": (
    status: "connected" | "disconnected" | "reconnecting"
  ) => void
  "auth:expired": () => void
  error: (error: Error) => void
}

export type ChatEventName = keyof ChatEventMap

// ─── Push notification / background event types ─────────────

export interface PushEventResult {
  /** Whether the payload was recognized and handled. */
  handled: boolean
  /** The event name that was processed. */
  event?: ChatEventName
  /** The parsed event payload data. */
  data?: Record<string, unknown>
  /** Event sequence number for duplicate prevention on WS reconnect. */
  sequence?: number
}

export type PushEventPayload =
  | { event: "new_message"; message: Record<string, unknown>; _sequence?: number }
  | { event: "conversation:created"; conversation: Record<string, unknown>; _sequence?: number }
  | { event: "conversation:updated"; conversation: Record<string, unknown>; _sequence?: number }
  | { event: "messages_read"; conversation_id: string; reader_id: string; read_at: string; _sequence?: number }
  | { event: "messages_delivered"; conversation_id: string; user_id: string; _sequence?: number }
  | { event: "unread_count"; conversation_id: string; unread_count: number; _sequence?: number }

// ─── Options ────────────────────────────────────────────────

export interface ChatClientOptions {
  baseUrl: string
  wsUrl: string
  storage: ChatStorage
  context?: ContactContext
  onTokenExpired?: () => Promise<AuthTokens | null>
}
