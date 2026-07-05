export { ChatClient } from './chat-client.js';
export { PhoenixSocket } from './phoenix-socket.js';
export { ChatStore, StoreKeys } from './store/store.js';
export { ChatChannel } from './channels/chat-channel.js';
export { EventsChannel } from './channels/events-channel.js';
export { MessageService, generateLocalId, normalizeMessagePayload } from './message-service.js';
export { ConversationService, formatConversationTime } from './conversation-service.js';
export { createInMemoryStorage, storageKey } from './store/storage.js';
export { createMMKVStorageAdapter } from './adapters/mmkv-adapter.js';
export { IndexedDBStorageAdapter } from './adapters/indexeddb-adapter.js';
export { parseMarkdown } from './text-parser.js';
export { getChatTopic, getEventsTopic, buildSupportChannelUrl } from './topics.js';

export type {
  ConnectionState,
  Message,
  MessageStatus,
  OutboundMessage,
  OutboxStatus,
  Conversation,
  ConversationParticipant,
  CreateConversationParams,
  Contact,
  JoinResult,
  SendResult,
  TypingData,
  MessagesReadData,
  MessagesDeliveredData,
  PresenceData,
  PresenceMeta,
  ConnectionChangeData,
  ChatClientConfig,
  IStorageAdapter,
  PhoenixV2Frame,
  PhoenixOutbound,
  EventsChannelEvent,
  EventHandler,
  RawMessagePayload,
  ChatEventHandler,
  ChatMessageStatus,
  StoredMessage,
  ChatMessagePayload,
  InboxConversation,
} from './types.js';

export { useChat } from './react/use-chat.js';
export type { UseChatOptions, UseChatReturn, UserProfile } from './react/use-chat.js';
