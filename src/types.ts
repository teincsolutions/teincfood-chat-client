export const PHOENIX_VSN = '2.0.0';
export const HEARTBEAT_INTERVAL_MS = 15_000;
export const HEARTBEAT_TIMEOUT_MS = 10_000;
export const RECONNECT_BASE_DELAY_MS = 1_000;
export const RECONNECT_MAX_DELAY_MS = 30_000;
export const RECONNECT_MAX_ATTEMPTS = 10;
export const MESSAGE_PAGE_SIZE = 50;
export const TYPING_TIMEOUT_MS = 3_000;
export const PUSH_TIMEOUT_MS = 5_000;
export const JOIN_TIMEOUT_MS = 10_000;

export type ConnectionState =
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'reconnecting'
  | 'failed';

export type MessageStatus =
  | 'sending'
  | 'sent'
  | 'delivered'
  | 'read'
  | 'failed'
  | 'queued';

export type OutboxStatus = 'queued' | 'sending' | 'sent' | 'failed';

export interface Message {
  id: string;
  localId: string;
  conversationId: string;
  senderId: string;
  text: string;
  status: MessageStatus;
  channel: 'app' | 'whatsapp';
  messageType: 'text' | 'image' | 'document' | 'video' | 'audio' | 'interactive';
  sentAt: string;
  deliveredAt?: string;
  readAt?: string;
  metadata?: Record<string, unknown>;
}

export interface OutboundMessage {
  id: string;
  topic: string;
  conversationId: string;
  text: string;
  status: OutboxStatus;
  queuedAt: number;
}

export interface RawMessagePayload {
  id?: string;
  user_id?: string;
  sender_id?: string;
  content?: string;
  text?: string;
  conversation_id?: string;
  channel?: 'app' | 'whatsapp';
  message_type?: string;
  status?: string;
  direction?: string;
  sent_at?: string;
  inserted_at?: string;
  metadata?: Record<string, unknown>;
}

export interface Conversation {
  id: string;
  type: 'direct' | 'business_group' | 'support' | 'internal';
  status: 'active' | 'closed';
  assignedAgentId?: string;
  orderId?: string;
  businessId?: string;
  participants?: ConversationParticipant[];
  lastMessage?: {
    text: string;
    senderId: string;
    sentAt: string;
  };
  unreadCount?: number;
  insertedAt: string;
  updatedAt: string;
}

export interface CreateConversationParams {
  type: 'direct' | 'business_group' | 'support';
  userId?: string;
  otherUserId?: string;
  businessId?: string;
  orderId?: string;
}

export interface Contact {
  id: string;
  fullName: string;
  avatarUrl?: string;
  phone?: string;
}

export interface ConversationParticipant {
  id: string;
  userId: string;
  archivedAt?: string;
}

export interface JoinResult {
  topic: string;
  conversationId?: string;
}

export interface SendResult {
  localId: string;
  serverId?: string;
  status: MessageStatus;
}

export interface TypingData {
  senderId: string;
  isTyping: boolean;
}

export interface MessagesReadData {
  conversationId: string;
  readerId: string;
  readAt: string;
}

export interface MessagesDeliveredData {
  conversationId: string;
  userId: string;
  deliveredAt: string;
}

export interface PresenceMeta {
  user_id: string;
  online_at: number;
}

export interface PresenceData {
  [userId: string]: {
    metas: PresenceMeta[];
  };
}

export interface ConnectionChangeData {
  state: ConnectionState;
  previous: ConnectionState;
}

export type ChatMessageStatus = 'sending' | 'sent' | 'delivered' | 'read' | 'failed' | 'queued';

export interface StoredMessage {
  id: string;
  localId: string;
  conversationId: string;
  senderId: string;
  text: string;
  status: ChatMessageStatus;
  channel: 'app' | 'whatsapp';
  sentAt: string;
  sortKey?: number;
  deliveredAt?: string;
  readAt?: string;
}

export interface ChatMessagePayload {
  id?: string;
  sender_id: string;
  text: string;
  content?: string;
  user_id?: string;
  sent_at?: string;
  inserted_at?: string;
  conversation_id?: string;
  channel?: 'app' | 'whatsapp';
  status?: string;
  message_type?: string;
  direction?: string;
}

export interface InboxConversation {
  id: string;
  name: string;
  avatar?: string;
  lastMessage: string;
  unreadCount: number;
  time: string;
  type?: string;
  participantUserId?: string;
  businessId?: string;
  orderId?: string;
}

export type ChatEventHandler =
  | { event: 'message'; data: Message }
  | { event: 'typing'; data: TypingData }
  | { event: 'connection'; data: ConnectionChangeData }
  | { event: 'error'; data: Error };

export type EventHandler<T = unknown> = (data: T) => void;

export interface ChatClientConfig {
  wsBaseUrl: string;
  apiBaseUrl: string;
  getAccessToken: () => Promise<string>;
  storage: IStorageAdapter;
  websocketImplementation?: typeof WebSocket;
  heartbeatIntervalMs?: number;
  maxHeartbeatMisses?: number;
  messagePageSize?: number;
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
  reconnectMaxAttempts?: number;
  joinTimeoutMs?: number;
  pushTimeoutMs?: number;
}

export interface IStorageAdapter {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
  getAllKeys(): Promise<string[]>;
  subscribe?(key: string, cb: (value: string | null) => void): () => void;
}

export type PhoenixV2Frame = [
  joinRef: string | null,
  ref: string | null,
  topic: string,
  event: string,
  payload: Record<string, unknown>,
];

export interface PhoenixOutbound {
  topic: string;
  event: string;
  payload: Record<string, unknown>;
  ref?: string;
  joinRef?: string | null;
}

export interface EventsChannelEvent {
  type: string;
  payload: Record<string, unknown>;
  sequence: number;
  occurredAt: string;
}
