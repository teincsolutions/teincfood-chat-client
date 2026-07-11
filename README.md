# teincfood-chat-client

Headless, event-driven chat client for TeincFood. Connects to the TeincFood Phoenix backend via raw WebSocket (Phoenix v2 protocol) for real-time messaging and REST for initial data load.

## Features

- **Event-driven** — all data flows through WebSocket events. No polling.
- **Optimistic UI** — messages appear instantly, reconciled when the server confirms.
- **Auto-mark-read** — joining a conversation automatically marks messages as read (like WhatsApp).
- **Background push handling** — `handlePushPayload()` processes push notification events when the app is in background (where WS is killed).
- **Pluggable storage** — bring your own adapter (AsyncStorage, MMKV, etc.).
- **React hooks** — optional `useChat`, `useConversations`, `useContacts`.
- **Typed events** — full TypeScript types for every event payload.

## Architecture

```
┌──────────────┐     WebSocket (Phoenix v2)     ┌─────────────┐
│  ChatClient  │ ──────────────────────────────  │  Backend    │
│              │    events:{userId}              │             │
│  ┌────────┐  │    ─ conversation:created       │  Phoenix    │
│  │ Store  │◄──── ─ conversation:updated       │  Channels   │
│  ├────────┤  │    ─ new_message                │             │
│  │ Emitter│  │    ─ messages_read              │             │
│  ├────────┤  │    ─ unread_count               │             │
│  │ Socket │───                                 │             │
│  ├────────┤  │    chat:{conversationId}        │             │
│  │Optimist│  │    ─ new_message (send/recv)    │             │
│  └────────┘  │    ─ mark_read                  │             │
│              │    ─ typing                     │             │
│              │    ─ presence_state/diff        │             │
└──────────────┘                                 └─────────────┘
```

Two channel types:

- **`events:{userId}`** — user-level channel. Receives `conversation:created`, `conversation:updated`, `new_message`, `messages_read`, `unread_count`. Auto-joined on `start()`. Uses `last_sequence` to avoid replaying events seen via push notifications.
- **`chat:{conversationId}`** — per-conversation channel. Used for sending messages, typing indicators, presence, and auto-mark-read on join.

## Installation

```bash
npm install teincfood-chat-client
```

## Quick Start

```typescript
import { ChatClient } from "teincfood-chat-client"
import AsyncStorage from "@react-native-async-storage/async-storage"

const storage: ChatStorage = {
  getItem: (key) => AsyncStorage.getItem(key).then((v) => v ? JSON.parse(v) : null),
  setItem: (key, value) => AsyncStorage.setItem(key, JSON.stringify(value)),
  removeItem: (key) => AsyncStorage.removeItem(key),
  clear: () => AsyncStorage.clear(),
}

const client = new ChatClient({
  baseUrl: "https://api.teincfood.com/api/v1",
  wsUrl: "wss://api.teincfood.com/ws",
  storage,
})

// Set current user and connect
client.setCurrentUserId("user-uuid")
await client.start({
  access_token: "jwt-access-token",
  refresh_token: "jwt-refresh-token",
})

// Listen for events
client.on("message:received", (msg) => {
  console.log("New message:", msg.content)
})

client.on("conversation:created", ({ conversation }) => {
  console.log("New conversation:", conversation.id)
})

// Join a conversation and send a message
await client.joinConversation("conv-uuid")
client.sendMessage("conv-uuid", "Hello, world!")

// Receipt: wait for the message:sent confirmation
client.on("message:sent", (msg) => {
  console.log("Message confirmed by server:", msg.id)
})
```

## Configuration

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `baseUrl` | `string` | yes | REST API base URL (e.g. `https://api.example.com/api/v1`) |
| `wsUrl` | `string` | yes | WebSocket endpoint (e.g. `wss://api.example.com/ws`) |
| `storage` | `ChatStorage` | yes | Persistent storage adapter |
| `onTokenExpired` | `() => Promise<AuthTokens \| null>` | no | Called on 401. Return new tokens or `null` to trigger `auth:expired`. |

## API Reference

### Lifecycle

#### `start(tokens: AuthTokens): Promise<void>`

Hydrate cached data from storage, connect the WebSocket, and auto-join the `events:{userId}` channel.

```typescript
await client.start({
  access_token: "...",
  refresh_token: "...",
})
```

#### `stop(): void`

Disconnect WebSocket, leave events channel, clear optimistic messages and all event listeners.

#### `clearCache(): Promise<void>`

Clear all local data from the store and storage adapter.

### Token & User Management

| Method | Returns | Description |
|--------|---------|-------------|
| `getTokens()` | `AuthTokens \| null` | Current tokens |
| `setTokens(tokens)` | `void` | Update tokens |
| `getCurrentUserId()` | `string \| null` | Current user ID |
| `setCurrentUserId(userId)` | `void` | Set user ID (auto-joins events channel if WS connected) |

### Real-time Messaging

#### `sendMessage(conversationId: string, body: string, metadata?: Record<string, unknown> | null): TempMessage`

Send a text message. Creates an optimistic message immediately and pushes to the WebSocket. The `message:sent` event fires when the server confirms.

- Must be joined to the conversation channel first.
- Returns a `TempMessage` (has `_clientId` for reconciliation tracking).
- On failure, `message:failed` event fires and `temp.status` becomes `"failed"`.

```typescript
client.sendMessage("conv-1", "Hello!", { priority: "high" })
```

#### `joinConversation(conversationId: string): Promise<void>`

Join a conversation channel for live updates. Automatically pushes `mark_read` on join (like WhatsApp), which triggers `messages_read` events for other participants.

```typescript
await client.joinConversation("conv-1")
```

#### `leaveConversation(conversationId: string): void`

Leave a conversation channel.

#### `markRead(conversationId: string): void`

Manually push `mark_read` to a conversation.

#### `sendTyping(conversationId: string): void`

Push a typing indicator to a conversation.

#### `fetchMessages(conversationId: string, limit?: number): void`

Request message history via WebSocket. Emits `messages:loaded` when the server responds.

### REST Helpers

These make one-time HTTP requests and cache the results in the store. Primarily used for initial data load or fallback.

| Method | Returns | Description |
|--------|---------|-------------|
| `loadInbox()` | `Promise<Conversation[]>` | Fetch inbox from REST, cache in store |
| `loadContacts(context?, businessId?, q?)` | `Promise<Contact[]>` | Fetch contacts from REST, cache in store |
| `loadMessages(convId, limit?, offset?)` | `Promise<{ data: Message[]; meta: MessageListMeta }>` | Fetch message page from REST, cache in store |

### Background Push Notification Handling

#### `handlePushPayload(payload: Record<string, unknown>): PushEventResult`

Process a remote push notification payload outside the WebSocket connection.

On mobile platforms, the WebSocket is killed when the app goes to background. Push notifications carry the event data directly. This method routes the payload through the same store + event logic as the live events channel.

```typescript
// In your React Native push notification handler:
function onPushNotification(notification: { data: Record<string, unknown> }) {
  const result = client.handlePushPayload(notification.data)
  if (result.handled) {
    console.log(`Processed ${result.event}`)
  }
}
```

**`PushEventResult`:**

```typescript
interface PushEventResult {
  handled: boolean
  event?: ChatEventName
  data?: Record<string, unknown>
  sequence?: number
}
```

When the WS reconnects, `joinEventsChannel` sends `{ last_sequence: N }` to avoid replaying events already seen via push notifications.

### Sub-APIs

Each sub-API is a namespace of REST methods accessible via `client.*`:

```typescript
client.auth                   // login, register, refresh, otp, oidc
client.conversations          // getInbox, getConversation, startChat, close, listSupportConversations
client.messages               // list, sendText, sendMedia
client.contacts               // getContacts
client.notifications          // list, getUnreadCount
client.upload                 // getUploadUrl
```

### Event Subscriptions

#### `on<E extends ChatEventName>(event: E, listener: ChatEventMap[E]): () => void`

Subscribe to an event. Returns an unsubscribe function.

```typescript
const unsub = client.on("message:received", (msg) => {
  console.log(msg.content)
})
// Later:
unsub()
```

#### `off<E extends ChatEventName>(event: E, listener: ChatEventMap[E]): void`

Remove a specific listener.

### Store

#### `store: ChatStore`

The client's in-memory store, also persisted to the storage adapter.

| Method | Returns | Description |
|--------|---------|-------------|
| `getMessages(conversationId)` | `Message[]` | Messages for a conversation |
| `getConversations()` | `Conversation[]` | All cached conversations, sorted by updated_at desc |
| `getConversation(id)` | `Conversation \| undefined` | Single conversation |
| `getContacts()` | `Contact[]` | Cached contacts |

## Event Reference

All 14 events with their payload types:

| Event | Payload | Description |
|-------|---------|-------------|
| `message:sending` | `TempMessage` | Optimistic message created |
| `message:sent` | `Message` | Message confirmed by server (via reconciliation) |
| `message:received` | `Message` | New message from another user |
| `message:failed` | `TempMessage` | Message send failed |
| `messages:loaded` | `{ conversationId, messages }` | Message history from `fetchMessages` |
| `conversation:created` | `{ conversation }` | New conversation from events channel |
| `conversation:updated` | `{ conversation }` | Conversation updated |
| `unread_count` | `{ conversationId, unread_count }` | Unread count changed |
| `typing` | `{ conversationId, userId }` | User is typing |
| `messages_read` | `{ conversationId, userId, readAt }` | Messages read receipt |
| `messages_delivered` | `{ conversationId, userId }` | Messages delivered receipt |
| `presence` | `{ conversationId, users }` | Presence state change |
| `connection:status` | `"connected" \| "disconnected" \| "reconnecting"` | WS connection state |
| `auth:expired` | `void` | Token expired (onTokenExpired returned null) |
| `error` | `Error` | Internal error |

## Storage Adapters

Implement the `ChatStorage` interface for your platform:

```typescript
interface ChatStorage {
  getItem<T = unknown>(key: string): Promise<T | null>
  setItem<T = unknown>(key: string, value: T): Promise<void>
  removeItem(key: string): Promise<void>
  clear(): Promise<void>
}
```

**React Native (AsyncStorage):**

```typescript
import AsyncStorage from "@react-native-async-storage/async-storage"

const storage: ChatStorage = {
  getItem: (key) => AsyncStorage.getItem(key).then((v) => v ? JSON.parse(v) : null),
  setItem: (key, value) => AsyncStorage.setItem(key, JSON.stringify(value)),
  removeItem: (key) => AsyncStorage.removeItem(key),
  clear: () => AsyncStorage.clear(),
}
```

**React Native (MMKV):**

```typescript
import { MMKV } from "react-native-mmkv"

const mmkv = new MMKV()

const storage: ChatStorage = {
  getItem: async (key) => {
    const v = mmkv.getString(key)
    return v ? JSON.parse(v) : null
  },
  setItem: async (key, value) => mmkv.set(key, JSON.stringify(value)),
  removeItem: async (key) => mmkv.delete(key),
  clear: async () => mmkv.clearAll(),
}
```

## React Hooks

Optional React hooks for component-level state:

```typescript
import { useChat, useConversations, useContacts } from "teincfood-chat-client"

function ChatScreen() {
  const { messages, send } = useChat("conv-1")
  const { conversations } = useConversations()
  const { contacts } = useContacts()

  return (
    <FlatList
      data={messages}
      renderItem={({ item }) => <Text>{item.content}</Text>}
    />
  )
}
```

Hooks use `useSyncExternalStore` under the hood — no `useEffect` polling, purely event-driven.

## Background / Foreground Pattern

When the app goes to background on iOS/Android, the WebSocket is killed. Push notifications deliver event data directly:

```
App in foreground → WS connected → events arrive in real-time
App in background  → WS killed    → push notification arrives
App tapped / opened → WS reconnects → events channel joins with last_sequence
```

```typescript
// Push notification handler (runs in background)
function onPushNotification(notification) {
  const result = client.handlePushPayload(notification.data)
  if (result.handled && result.event === "message:received") {
    // Show a local notification
  }
}

// App foreground handler
function onAppForeground() {
  // WS reconnects automatically via start()
  // Events channel uses stored last_sequence to skip duplicates
}
```

## Error Handling

```typescript
// HTTP errors (REST calls)
try {
  await client.loadInbox()
} catch (err) {
  if (err instanceof HttpError) {
    console.error(err.status, err.message) // e.g. 401, 404, 500
  }
}

// Auth expiry
client.on("auth:expired", () => {
  // Redirect to login
})

// WS connection changes
client.on("connection:status", (status) => {
  if (status === "disconnected") {
    // Show offline indicator
  }
})
```

## TypeScript Types

All types are exported from the package:

```typescript
import type {
  Message, TempMessage,
  Conversation, Contact,
  AuthTokens, ChatStorage,
  ChatEventMap, ChatEventName,
  ChatClientOptions,
  PushEventResult,
  MessagesReadPayload,
  PresencePayload,
  ConversationCreatedPayload,
  ConversationUpdatedPayload,
} from "teincfood-chat-client"
```

## Utils

```typescript
import { toMessage, toConversation, retry, HttpError } from "teincfood-chat-client"
```

- `toMessage(raw)` — parse a raw payload into a typed `Message`
- `toConversation(raw)` — parse a raw payload into a typed `Conversation`
- `retry(fn, options?)` — retry an async function with exponential backoff
- `HttpError` — HTTP error class with `status`, `statusText`, `detail`

## Development

```bash
npm run build          # TypeScript compile
npx vitest run         # Run all tests
npx vitest run --reporter=verbose  # Verbose output
npm test               # Alias for vitest
```

### Test structure

- `src/unit.test.ts` — 32 unit tests: store, socket events, push payload, optimistic engine, emitter
- `src/integration.test.ts` — 6 integration tests against localhost:4000: presence, send/receive, auto-mark-read, auth expiry, error handling
