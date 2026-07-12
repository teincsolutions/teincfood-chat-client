import {
  useSyncExternalStore,
  useCallback,
  useRef,
  useEffect,
  startTransition,
} from "react"
import type { ChatClient } from "./client"
import type {
  Message,
  Conversation,
  Contact,
  ContactContext,
  TempMessage,
} from "./types"

// ════════════════════════════════════════════════════════════
// Helper — build a reactive subscribe/store tuple from
//             an external source.
// ════════════════════════════════════════════════════════════

function externalStore<T>(getSnapshot: () => T) {
  let snapshot = getSnapshot()
  const listeners = new Set<() => void>()

  const subscribe = (cb: () => void) => {
    listeners.add(cb)
    return () => listeners.delete(cb)
  }

  const emit = () => {
    const next = getSnapshot()
    if (next !== snapshot) {
      snapshot = next
      startTransition(() => listeners.forEach((fn) => fn()))
    }
  }

  return { subscribe, getSnapshot: () => snapshot, emit }
}

// ════════════════════════════════════════════════════════════
// useChat — messages + send for a single conversation
// ════════════════════════════════════════════════════════════

export interface UseChatResult {
  messages: Message[]
  send: (body: string, metadata?: Record<string, unknown> | null) => TempMessage
  loadMore: () => Promise<void>
  sendTyping: () => void
  markRead: () => void
  hasMore: boolean
  loading: boolean
  error: Error | null
}

export function useChat(
  client: ChatClient,
  conversationId: string | null,
): UseChatResult {
  const loadingRef = useRef(false)
  const offsetRef = useRef(0)
  const hasMoreRef = useRef(true)
  const errorRef = useRef<Error | null>(null)

  const getMessages = useCallback(() => {
    if (!conversationId) return [] as Message[]
    const stored = client.store.getMessages(conversationId)
    const pending = client.getPendingMessages(conversationId)

    const pendingMap = new Map<string, TempMessage>()
    for (const p of pending) {
      pendingMap.set(`pending_${p._clientId}`, p)
    }

    for (const m of stored) {
      if (m.id) pendingMap.delete(`pending_${m.id}`)
    }

    const all = [...stored, ...pendingMap.values()]
    all.sort(
      (a, b) =>
        new Date(a.inserted_at).getTime() -
        new Date(b.inserted_at).getTime(),
    )
    return all
  }, [conversationId, client])

  const store = useRef(externalStore(getMessages)).current

  // Subscribe to relevant events + join conversation channel
  useEffect(() => {
    if (!conversationId) return

    let cancelled = false

    ;(async () => {
      try {
        await client.joinConversation(conversationId)
        if (!cancelled) {
          // Load messages from REST as the authoritative source
          await client.loadMessages(conversationId, 50, 0)
          store.emit()
        }
      } catch {
        // Channel join failed — REST calls still work via loadMessages
        try {
          if (!cancelled) {
            await client.loadMessages(conversationId, 50, 0)
            store.emit()
          }
        } catch {}
      }
    })()

    const unsubs = [
      client.on("message:sending", () => store.emit()),
      client.on("message:sent", () => store.emit()),
      client.on("message:received", () => store.emit()),
      client.on("message:failed", () => store.emit()),
      client.on("messages:loaded", (p) => {
        if (p.conversationId === conversationId) store.emit()
      }),
      client.on("messages_read", () => store.emit()),
      client.on("messages_delivered", () => store.emit()),
    ]

    return () => {
      cancelled = true
      unsubs.forEach((fn) => fn())
      client.leaveConversation(conversationId)
    }
  }, [conversationId, client, store])

  const messages = useSyncExternalStore(store.subscribe, store.getSnapshot)

  const send = useCallback(
    (body: string, metadata?: Record<string, unknown> | null) => {
      if (!conversationId) throw new Error("No active conversation")
      return client.sendMessage(conversationId, body, metadata)
    },
    [conversationId, client],
  )

  const loadMore = useCallback(async () => {
    if (!conversationId || !hasMoreRef.current || loadingRef.current) return
    loadingRef.current = true
    errorRef.current = null

    try {
      offsetRef.current += 50
      const result = await client.loadMessages(
        conversationId,
        50,
        offsetRef.current,
      )
      hasMoreRef.current = result.data.length === 50
      store.emit()
    } catch (e) {
      errorRef.current = e instanceof Error ? e : new Error(String(e))
      offsetRef.current -= 50
    } finally {
      loadingRef.current = false
    }
  }, [conversationId, client, store])

  const sendTyping = useCallback(() => {
    if (conversationId) client.sendTyping(conversationId)
  }, [conversationId, client])

  const markRead = useCallback(() => {
    if (conversationId) client.markRead(conversationId)
  }, [conversationId, client])

  return {
    messages,
    send,
    loadMore,
    sendTyping,
    markRead,
    hasMore: hasMoreRef.current,
    loading: loadingRef.current,
    error: errorRef.current,
  }
}

// ════════════════════════════════════════════════════════════
// useConversations — inbox list
// ════════════════════════════════════════════════════════════

export interface UseConversationsResult {
  conversations: Conversation[]
  loading: boolean
  refresh: () => Promise<void>
}

export function useConversations(
  client: ChatClient,
): UseConversationsResult {
  const loadingRef = useRef(false)

  const getConvs = useCallback(
    () => client.store.getConversations(),
    [client],
  )

  const store = useRef(externalStore(getConvs)).current

  useEffect(() => {
    const unsubs = [
      client.on("message:sent", () => store.emit()),
      client.on("message:received", () => store.emit()),
      client.on("messages_read", () => store.emit()),
      client.on("messages_delivered", () => store.emit()),
      client.on("conversation:created", () => store.emit()),
      client.on("conversation:updated", () => store.emit()),
    ]
    return () => unsubs.forEach((fn) => fn())
  }, [client, store])

  const conversations = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
  )

  const refresh = useCallback(async () => {
    loadingRef.current = true
    store.emit()
    try {
      await client.loadInbox()
    } finally {
      loadingRef.current = false
      store.emit()
    }
  }, [client, store])

  return {
    conversations,
    loading: loadingRef.current,
    refresh,
  }
}

// ════════════════════════════════════════════════════════════
// useContacts — contact list
// ════════════════════════════════════════════════════════════

export interface UseContactsResult {
  contacts: Contact[]
  loading: boolean
  refresh: () => Promise<void>
}

export function useContacts(
  client: ChatClient,
  context?: ContactContext,
  businessId?: string,
  q?: string,
): UseContactsResult {
  const loadingRef = useRef(false)
  const params = `${context ?? "buyer"}|${businessId ?? ""}|${q ?? ""}`

  const getContacts = useCallback(
    () => client.store.getContacts(),
    [client],
  )

  const store = useRef(externalStore(getContacts)).current

  const refresh = useCallback(async () => {
    loadingRef.current = true
    store.emit()
    try {
      await client.loadContacts(context, businessId, q)
    } finally {
      loadingRef.current = false
      store.emit()
    }
  }, [client, store, context, businessId, q])

  useEffect(() => {
    refresh()
  }, [params]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const unsubs = [
      client.on("message:sent", () => store.emit()),
      client.on("message:received", () => store.emit()),
      client.on("messages_read", () => store.emit()),
      client.on("messages_delivered", () => store.emit()),
      client.on("conversation:created", () => store.emit()),
      client.on("conversation:updated", () => store.emit()),
    ]
    return () => unsubs.forEach((fn) => fn())
  }, [client, store])

  const contacts = useSyncExternalStore(store.subscribe, store.getSnapshot)

  return {
    contacts,
    loading: loadingRef.current,
    refresh,
  }
}
