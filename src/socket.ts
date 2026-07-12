import type { Message, Conversation, PresenceUser } from "./types"
import { TypedEventEmitter } from "./events"
import { OptimisticEngine } from "./optimistic"
import { ChatStore } from "./store"

const HEARTBEAT_INTERVAL_MS = 5000
const MAX_MISSED_HEARTBEATS = 3
const CONNECT_TIMEOUT_MS = 10000
const PUSH_TIMEOUT_MS = 10000
const JOIN_TIMEOUT_MS = 5000
const RECONNECT_BASE_DELAY_MS = 1000
const RECONNECT_MAX_DELAY_MS = 15000
const MAX_AUTH_RETRIES = 3

export type FrameHandler = (frame: PhoenixV2Frame) => void

export type PhoenixV2Frame = [
  joinRef: string | null,
  ref: string | null,
  topic: string,
  event: string,
  payload: Record<string, unknown>,
]

interface PendingJoin {
  resolve: (resp: Record<string, unknown>) => void
  reject: (err: Error) => void
}

interface PendingPush {
  resolve: (resp: Record<string, unknown>) => void
  reject: (err: Error) => void
}

export class PhoenixChatSocket {
  private ws: WebSocket | null = null
  private refCounter = 0
  private joinedChannels = new Set<string>()
  private pendingJoins = new Map<string, PendingJoin>()
  private pendingPushes = new Map<string, PendingPush>()
  private topicJoinRefs = new Map<string, string | null>()
  private frameHandlers = new Map<string, Set<FrameHandler>>()
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private heartbeatPend = false
  private heartbeatMissed = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempts = 0
  private reconnectMaxDelay = RECONNECT_MAX_DELAY_MS
  private shouldReconnect = true
  private emitter: TypedEventEmitter
  private optimistic: OptimisticEngine
  private store: ChatStore
  private wsUrl: string
  private token: string = ""
  currentUserId: string | null = null

  constructor(
    wsUrl: string,
    emitter: TypedEventEmitter,
    optimistic: OptimisticEngine,
    store: ChatStore,
  ) {
    this.wsUrl = wsUrl
    this.emitter = emitter
    this.optimistic = optimistic
    this.store = store
  }

  private getRef(): string {
    return String(++this.refCounter)
  }

  private buildUrl(): string {
    if (!this.wsUrl) {
      throw new Error(
        "WebSocket URL is not configured. Pass a valid `wsUrl` to ChatClientOptions.",
      )
    }
    const base = this.wsUrl.replace(/\/+$/, "")
    const path = base.endsWith("/ws") ? "/websocket" : "/ws/websocket"
    return `${base}${path}?token=${encodeURIComponent(this.token)}&vsn=2.0.0`
  }

  // ─── Connection lifecycle ─────────────────────────

  async connect(token: string): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) return
    this.token = token
    this.shouldReconnect = true

    const url = this.buildUrl()
    return new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(url)

      const timeout = setTimeout(() => {
        if (this.ws?.readyState !== WebSocket.OPEN) {
          this.ws?.close()
          this.ws = null
          reject(new Error("WebSocket connection timed out"))
        }
      }, CONNECT_TIMEOUT_MS)

      this.ws.onopen = () => {
        clearTimeout(timeout)
        this.heartbeatPend = false
        this.heartbeatMissed = 0
        this.startHeartbeat()
        this.emitter.emit("connection:status", "connected")
        resolve()
      }

      this.ws.onclose = () => {
        clearTimeout(timeout)
        this.stopHeartbeat()
        this.emitter.emit("connection:status", "disconnected")
        this.scheduleReconnect()
      }

      this.ws.onerror = () => {
        clearTimeout(timeout)
        reject(new Error("WebSocket connection failed"))
      }

      this.ws.onmessage = (event: MessageEvent) => {
        try {
          const frame: PhoenixV2Frame = JSON.parse(event.data as string)
          this.handleFrame(frame)
        } catch {
          // silently skip malformed frames
        }
      }
    })
  }

  disconnect(): void {
    this.shouldReconnect = false
    this.cancelReconnect()
    this.stopHeartbeat()
    this.joinedChannels.clear()
    this.pendingJoins.clear()
    this.pendingPushes.clear()
    this.topicJoinRefs.clear()
    this.frameHandlers.clear()
    this.ws?.close()
    this.ws = null
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect) return
    this.cancelReconnect()
    this.emitter.emit("connection:status", "reconnecting")
    const delay = Math.min(
      RECONNECT_BASE_DELAY_MS * Math.pow(2, this.reconnectAttempts),
      this.reconnectMaxDelay,
    )
    this.reconnectAttempts++
    this.reconnectTimer = setTimeout(() => this.reconnect(), delay)
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private async reconnect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) return
    const token = this.token
    if (!token) return

    // After MAX_AUTH_RETRIES consecutive failures, assume stale token
    if (this.reconnectAttempts >= MAX_AUTH_RETRIES) {
      this.reconnectAttempts = 0
      this.emitter.emit("auth:expired")
      return
    }

    const prevEventsTopic = this.eventsTopic
    const prevChannels = Array.from(this.joinedChannels)

    // Clear state so joinConversation/joinEventsChannel
    // actually send phx_join frames on the new socket
    this.joinedChannels.clear()
    this.pendingJoins.clear()
    this.pendingPushes.clear()
    this.topicJoinRefs.clear()
    this.eventsTopic = null

    try {
      await this.connect(token)
      this.reconnectAttempts = 0

      // Rejoin events channel
      if (prevEventsTopic) {
        const userId = prevEventsTopic.replace("events:", "")
        await this.joinEventsChannel(userId).catch(() => {})
      }

      // Rejoin conversation channels
      for (const topic of prevChannels) {
        if (topic.startsWith("chat:")) {
          const convId = topic.replace("chat:", "")
          await this.joinConversation(convId).catch(() => {})
        }
      }

      // Retry failed optimistic messages after all channels re-joined
      this.retryFailedMessages()
    } catch {
      this.scheduleReconnect()
    }
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  /** Check if joined to a conversation channel. */
  isJoined(conversationId: string): boolean {
    const topic = `chat:${conversationId}`
    return this.joinedChannels.has(topic)
  }

  /** Check if joined to the events channel. */
  isEventsJoined(): boolean {
    return this.eventsTopic !== null && this.joinedChannels.has(this.eventsTopic)
  }

  /** Update the auth token and reconnect immediately. */
  updateToken(token: string): void {
    this.token = token
    this.reconnectAttempts = 0
    // Close the current WS without clearing state — onclose → scheduleReconnect
    // will pick up the new token on next connect attempt
    this.stopHeartbeat()
    this.ws?.close()
  }

  async reconnectWithToken(token: string): Promise<void> {
    this.disconnect()
    const convIds = Array.from(this.joinedChannels)
    await this.connect(token)
    for (const topic of convIds) {
      const convId = topic.replace("chat:", "")
      await this.joinConversation(convId)
    }
  }

  // ─── Events channel ───────────────────────────────

  private eventsTopic: string | null = null
  private lastSequence = 0

  /** Set the last known event sequence (e.g. from a push notification payload). */
  setLastSequence(seq: number): void {
    if (seq > this.lastSequence) {
      this.lastSequence = seq
    }
  }

  /** Get the last known event sequence. */
  getLastSequence(): number {
    return this.lastSequence
  }

  /** Join the user-level events channel. */
  async joinEventsChannel(userId: string): Promise<void> {
    const topic = `events:${userId}`
    if (this.joinedChannels.has(topic)) return
    if (!this.isConnected()) {
      throw new Error(`Socket not connected`)
    }
    this.eventsTopic = topic

    const ref = this.getRef()
    const joinPayload: Record<string, unknown> = {}
    if (this.lastSequence > 0) {
      joinPayload["last_sequence"] = this.lastSequence
    }

    return new Promise<void>((resolve, reject) => {
      this.pendingJoins.set(topic, { resolve: resolve as any, reject })
      this.sendRaw(topic, "phx_join", joinPayload, ref)

      setTimeout(() => {
        if (this.pendingJoins.has(topic)) {
          this.pendingJoins.delete(topic)
          reject(new Error(`Timeout joining ${topic}`))
        }
      }, JOIN_TIMEOUT_MS)

      this.onFrame(topic, this.makeEventsHandler())
    })
  }

  /** Leave the events channel. */
  leaveEventsChannel(): void {
    if (this.eventsTopic) {
      this.joinedChannels.delete(this.eventsTopic)
      this.pendingRejoin.delete(this.eventsTopic)
      this.topicJoinRefs.delete(this.eventsTopic)
      this.frameHandlers.delete(this.eventsTopic)
      this.eventsTopic = null
    }
  }

  private makeEventsHandler(): FrameHandler {
    return ([_joinRef, _ref, _topic, event, payload]) => {
      // Track event sequence for duplicate prevention
      const seq = payload._sequence as number | undefined
      if (typeof seq === "number" && seq > this.lastSequence) {
        this.lastSequence = seq
      }

      switch (event) {
        case "conversation:created":
        case "conversation:updated": {
          const raw = (payload.conversation ?? payload) as Record<string, unknown>
          const conv = toConversation(raw)
          this.store.upsertConversation(conv)
          if (event === "conversation:created") {
            this.emitter.emit("conversation:created", { conversation: conv })
          } else {
            this.emitter.emit("conversation:updated", { conversation: conv })
          }
          break
        }
        case "message.sent": {
          const convId = payload.entity_id as string
          const actorId = payload.actor_id as string | undefined
          if (convId && actorId !== this.currentUserId) {
            this.store.incrementContactUnread(convId)
            this.emitter.emit("message:received", null as any)
          }
          break
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
          break
        }
        case "messages_delivered": {
          this.store.markConversationDelivered(
            payload.conversation_id as string,
            payload.user_id as string,
          )
          this.emitter.emit("messages_delivered", {
            conversationId: payload.conversation_id as string,
            userId: payload.user_id as string,
          })
          break
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
          break
        }
      }
    }
  }

  // ─── Sending raw frames ───────────────────────────

  private sendRaw(
    topic: string,
    event: string,
    payload: Record<string, unknown>,
    ref?: string,
    joinRef?: string | null,
  ): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return
    const frame: PhoenixV2Frame = [
      joinRef ?? null,
      ref ?? null,
      topic,
      event,
      payload,
    ]
    this.ws.send(JSON.stringify(frame))
  }

  private push(
    topic: string,
    event: string,
    payload: Record<string, unknown>,
  ): void {
    const ref = this.getRef()
    const joinRef = this.topicJoinRefs.get(topic) ?? null
    this.sendRaw(topic, event, payload, ref, joinRef)
  }

  private pushWithReply(
    topic: string,
    event: string,
    payload: Record<string, unknown>,
    timeoutMs = PUSH_TIMEOUT_MS,
  ): Promise<Record<string, unknown>> {
    const ref = this.getRef()
    const joinRef = this.topicJoinRefs.get(topic) ?? null

    return new Promise((resolve, reject) => {
      this.pendingPushes.set(ref, { resolve, reject })
      this.sendRaw(topic, event, payload, ref, joinRef)

      setTimeout(() => {
        if (this.pendingPushes.has(ref)) {
          this.pendingPushes.delete(ref)
          reject(new Error(`Request timed out: ${event} on ${topic}`))
        }
      }, timeoutMs)
    })
  }

  // ─── Channel management ───────────────────────────

  async joinConversation(conversationId: string): Promise<void> {
    const topic = `chat:${conversationId}`
    if (this.joinedChannels.has(topic)) return

    if (!this.isConnected()) {
      throw new Error(`Socket not connected`)
    }

    const existing = this.pendingJoins.get(topic)
    if (existing) {
      // Wait for the in-flight join to settle by sharing its outcome
      return new Promise<void>((resolve, reject) => {
        const origResolve = existing.resolve
        const origReject = existing.reject
        existing.resolve = (resp) => { origResolve(resp); resolve(resp as any) }
        existing.reject = (err) => { origReject(err); reject(err) }
      })
    }

    const ref = this.getRef()
    await new Promise<void>((resolve, reject) => {
      this.pendingJoins.set(topic, { resolve: resolve as any, reject })
      this.sendRaw(topic, "phx_join", {}, ref)

      setTimeout(() => {
        if (this.pendingJoins.has(topic)) {
          this.pendingJoins.delete(topic)
          reject(new Error(`Timeout joining ${topic}`))
        }
      }, JOIN_TIMEOUT_MS)

      this.onFrame(topic, this.makeTopicHandler(conversationId))
    })

    // Auto-mark-read on join (like WhatsApp)
    this.push(topic, "mark_read", {})
  }

  private makeTopicHandler(
    conversationId: string,
  ): FrameHandler {
    return ([_joinRef, _ref, _topic, event, payload]) => {
      switch (event) {
        case "new_message":
          this.handleNewMessage(conversationId, payload)
          break
        case "messages_delivered":
          this.store.markConversationDelivered(
            conversationId,
            payload.user_id as string,
          )
          this.emitter.emit("messages_delivered", {
            conversationId,
            userId: payload.user_id as string,
          })
          break
        case "messages_read":
          this.store.markConversationRead(
            conversationId,
            payload.reader_id as string,
          )
          if (payload.reader_id === this.currentUserId) {
            this.store.resetContactUnread(conversationId)
          }
          this.emitter.emit("messages_read", {
            conversationId,
            userId: payload.reader_id as string,
            readAt: payload.read_at as string,
          })
          break
        case "typing":
          this.emitter.emit("typing", {
            conversationId,
            userId: payload.sender_id as string,
          })
          break
        case "presence_state":
          {
            const users = normalizePresence(payload)
            this.emitter.emit("presence", { conversationId, users })
          }
          break
        case "presence_diff":
          break
      }
    }
  }

  leaveConversation(conversationId: string): void {
    const topic = `chat:${conversationId}`
    this.joinedChannels.delete(topic)
    this.pendingRejoin.delete(topic)
    this.topicJoinRefs.delete(topic)
    this.frameHandlers.delete(topic)
  }

  // ─── Sending messages via WebSocket ───────────────

  sendMessage(
    conversationId: string,
    body: string,
    metadata?: Record<string, unknown> | null,
  ): void {
    const topic = `chat:${conversationId}`
    if (!this.joinedChannels.has(topic)) {
      console.warn(`[chat-client] Not joined to ${topic}, cannot send`)
      return
    }

    const payload: Record<string, unknown> = { body }
    if (metadata) payload["metadata"] = metadata
    this.push(topic, "new_message", payload)
  }

  sendTyping(conversationId: string): void {
    const topic = `chat:${conversationId}`
    if (this.joinedChannels.has(topic)) {
      this.push(topic, "typing", {})
    }
  }

  markRead(conversationId: string): void {
    const topic = `chat:${conversationId}`
    if (this.joinedChannels.has(topic)) {
      this.push(topic, "mark_read", {})
    }
  }

  fetchMessages(conversationId: string, limit = 50): void {
    const topic = `chat:${conversationId}`
    if (!this.joinedChannels.has(topic)) return

    this.pushWithReply(topic, "get_messages", { limit })
      .then((resp) => {
        const msgs = (resp.messages as Record<string, unknown>[]) ?? []
        const parsed = msgs.map(toMessage)
        this.store.setMessages(conversationId, parsed)
        this.emitter.emit("messages:loaded", {
          conversationId,
          messages: parsed,
        })
      })
      .catch(() => {})
  }

  // ─── Frame handling ───────────────────────────────

  onFrame(topic: string, handler: FrameHandler): () => void {
    if (!this.frameHandlers.has(topic)) {
      this.frameHandlers.set(topic, new Set())
    }
    this.frameHandlers.get(topic)!.add(handler)
    return () => {
      this.frameHandlers.get(topic)?.delete(handler)
    }
  }

  private handleFrame([joinRef, ref, topic, event, payload]: PhoenixV2Frame): void {
    // Heartbeat replies
    if (event === "phx_reply" && topic === "phoenix") {
      this.heartbeatPend = false
      this.heartbeatMissed = 0
      return
    }

    // Push replies (non-join)
    if (event === "phx_reply" && ref) {
      const pending = this.pendingPushes.get(ref)
      if (pending) {
        const status = payload?.status
        const response = (payload?.response ?? {}) as Record<string, unknown>
        if (status === "ok") {
          pending.resolve(response)
        } else {
          pending.reject(new Error(String((response as any).reason ?? "Request failed")))
        }
        this.pendingPushes.delete(ref)
        return
      }
    }

    // Join replies
    if (event === "phx_reply") {
      const status = payload?.status
      if (joinRef) {
        this.topicJoinRefs.set(topic, joinRef)
      }

      const pending = this.pendingJoins.get(topic)
      if (pending) {
        if (status === "ok") {
          const response = (payload?.response ?? {}) as Record<string, unknown>
          pending.resolve(response)
          this.joinedChannels.add(topic)
        } else {
          const response = (payload?.response ?? {}) as Record<string, unknown>
          pending.reject(new Error(String((response as any).reason ?? "Join failed")))
        }
        this.pendingJoins.delete(topic)
      }
      return
    }

    // Route to topic handlers
    const handlers = this.frameHandlers.get(topic)
    if (handlers) {
      handlers.forEach((cb) => cb([joinRef, ref, topic, event, payload]))
    }
  }

  // ─── Heartbeat ────────────────────────────────────

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      if (this.heartbeatPend) {
        this.heartbeatMissed++
        if (this.heartbeatMissed >= MAX_MISSED_HEARTBEATS) {
          this.ws?.close()
        }
        return
      }
      this.heartbeatPend = true
      this.sendRaw("phoenix", "heartbeat", {})
    }, HEARTBEAT_INTERVAL_MS)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    this.heartbeatPend = false
    this.heartbeatMissed = 0
  }

  // ─── Internal handlers ────────────────────────────

  private handleNewMessage(
    conversationId: string,
    payload: Record<string, unknown>,
  ): void {
    const serverMsg = toMessage(payload)

    const matchedClientId = this.optimistic.reconcile(serverMsg)
    if (matchedClientId) {
      this.store.upsertMessage(serverMsg.conversation_id, serverMsg)
      this.store.updateContactLastMessage(
        serverMsg.conversation_id,
        serverMsg.content,
        serverMsg.inserted_at,
      )
      this.emitter.emit("message:sent", serverMsg)
    } else {
      this.store.upsertMessage(serverMsg.conversation_id, serverMsg)
      this.store.updateContactLastMessage(
        serverMsg.conversation_id,
        serverMsg.content,
        serverMsg.inserted_at,
      )
      this.store.incrementContactUnread(serverMsg.conversation_id)
      this.emitter.emit("message:received", serverMsg)

      // Auto-mark as read for incoming messages from others
      const topic = `chat:${conversationId}`
      if (this.joinedChannels.has(topic)) {
        this.push(topic, "mark_read", {})
      }
    }
  }

  /**
   * Resend all optimistic messages with status "failed" across all
   * joined conversations. Called automatically after reconnection.
   */
  private retryFailedMessages(): void {
    const all = this.optimistic.getAll()
    for (const msg of all) {
      if (msg.status !== "failed") continue
      if (!this.isJoined(msg.conversation_id)) continue
      msg.status = "sending"
      this.emitter.emit("message:sending", msg)
      this.sendMessage(msg.conversation_id, msg.content, msg.metadata)
    }
  }

  // Rejoin set for reconnection
  private pendingRejoin = new Set<string>()
}

// ─── Helpers ──────────────────────────────────────────────

export function toMessage(p: Record<string, unknown>): Message {
  return {
    id: (p.id as string) ?? null,
    content: (p.content as string) ?? "",
    sender_id: p.sender_id as string,
    conversation_id: p.conversation_id as string,
    direction: (p.direction as Message["direction"]) ?? "inbound",
    channel: (p.channel as Message["channel"]) ?? "app",
    message_type: (p.message_type as Message["message_type"]) ?? "text",
    status: (p.status as Message["status"]) ?? "sent",
    external_id: (p.external_id as string) ?? null,
    metadata: (p.metadata as Record<string, unknown>) ?? null,
    replied_by_id: (p.replied_by_id as string) ?? null,
    read: (p.read as boolean) ?? false,
    sent_at: ((p.sent_at ?? p.inserted_at) as string),
    inserted_at: p.inserted_at as string,
  }
}

function normalizePresence(
  payload: Record<string, unknown>,
): PresenceUser[] {
  const result: PresenceUser[] = []
  for (const [, val] of Object.entries(payload)) {
    const entry = val as { metas?: Record<string, unknown>[] }
    const metas = entry.metas ?? []
    for (const meta of metas) {
      result.push({
        user_id: meta.user_id as string,
        online_at: meta.online_at as number,
      })
    }
  }
  return result
}

export function toConversation(p: Record<string, unknown>): Conversation {
  const rawMessages = (p.messages as Record<string, unknown>[]) ?? []
  return {
    id: p.id as string,
    status: (p.status as Conversation["status"]) ?? "active",
    order_id: (p.order_id as string) ?? null,
    business_id: (p.business_id as string) ?? null,
    business: p.business
      ? {
          id: (p.business as Record<string, unknown>).id as string,
          name: (p.business as Record<string, unknown>).name as string,
          logo_url:
            ((p.business as Record<string, unknown>).logo_url as string) ??
            null,
        }
      : null,
    participants: (p.participants as Conversation["participants"]) ?? [],
    messages: rawMessages.map(toMessage),
    inserted_at: p.inserted_at as string,
    updated_at: p.updated_at as string,
  }
}
