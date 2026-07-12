export { formatTime, formatDateSeparator, shouldShowDateSeparator } from "./formatters"

export { ChatClient } from "./client"
export { TypedEventEmitter } from "./events"
export { HttpError } from "./http"
export { retry } from "./retry"

export { toMessage, toConversation } from "./socket"

export type {
  Message,
  TempMessage,
  MessageDirection,
  MessageChannel,
  MessageType,
  MessageStatus,
  Conversation,
  ConversationStatus,
  Participant,
  ParticipantUser,
  BusinessSummary,
  Contact,
  ContactType,
  ContactContext,
  AuthTokens,
  LoginParams,
  RegisterParams,
  OtpSendParams,
  OtpVerifyParams,
  OidcParams,
  AppNotification,
  PaginationMeta,
  MessageListMeta,
  UploadUrlResult,
  PresenceUser,
  ChatStorage,
  MMKVStorage,
  ChatEventMap,
  ChatEventName,
  ChatClientOptions,
  PushEventResult,
  MessagesLoadedPayload,
  TypingPayload,
  MessagesReadPayload,
  MessagesDeliveredPayload,
  PresencePayload,
  ConversationCreatedPayload,
  ConversationUpdatedPayload,
  UnreadCountPayload,
} from "./types"

export { createMMKVStorageAdapter } from "./types"

export type { RetryOptions } from "./retry"
export type {
  StartChatParams,
  ContactTypeRaw,
} from "./api/conversations"

export type {
  AddContactParams,
} from "./api/contacts"

export {
  useChat,
  useConversations,
  useContacts,
} from "./react"

export type {
  UseChatResult,
  UseConversationsResult,
  UseContactsResult,
} from "./react"
