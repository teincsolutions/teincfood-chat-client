import type { Message, TempMessage } from "./types"
import { TypedEventEmitter } from "./events"

let clientIdCounter = 0
function nextClientId(): string {
  return `opt_${Date.now()}_${++clientIdCounter}`
}

export class OptimisticEngine {
  private pending = new Map<string, TempMessage>()
  private emitter: TypedEventEmitter

  constructor(emitter: TypedEventEmitter) {
    this.emitter = emitter
  }

  /** Create an optimistic message, emit 'message:sending', return it. */
  create(
    conversationId: string,
    senderId: string,
    body: string,
    metadata?: Record<string, unknown> | null,
  ): TempMessage {
    const now = new Date().toISOString()
    const msg: TempMessage = {
      _clientId: nextClientId(),
      id: null,
      content: body,
      sender_id: senderId,
      conversation_id: conversationId,
      direction: "inbound",
      channel: "app",
      message_type: "text",
      status: "sending",
      external_id: null,
      metadata: metadata ?? null,
      replied_by_id: null,
      read: false,
      sent_at: now,
      inserted_at: now,
    }
    this.pending.set(msg._clientId, msg)
    this.emitter.emit("message:sending", msg)
    return msg
  }

  /** Mark all pending messages for this conversation as failed. */
  failConversation(conversationId: string): void {
    for (const [cid, msg] of this.pending) {
      if (msg.conversation_id === conversationId) {
        msg.status = "failed"
        this.emitter.emit("message:failed", msg)
        this.pending.delete(cid)
      }
    }
  }

  /**
   * Reconcile — match a server-acknowledged message against pending temps.
   * Matching strategy: same conversation + same content + created within 10s window.
   * Returns the matched temp's _clientId (if any) for callers to identify it.
   */
  reconcile(serverMsg: Message): string | null {
    const serverTime = new Date(serverMsg.inserted_at).getTime()

    for (const [cid, temp] of this.pending) {
      if (temp.conversation_id !== serverMsg.conversation_id) continue
      if (temp.content !== serverMsg.content) continue

      const tempTime = new Date(temp.inserted_at).getTime()
      if (Math.abs(serverTime - tempTime) > 10_000) continue

      this.pending.delete(cid)
      return cid
    }

    return null
  }

  /** Return all pending messages for a conversation. */
  getPending(conversationId: string): TempMessage[] {
    return Array.from(this.pending.values()).filter(
      (m) => m.conversation_id === conversationId,
    )
  }

  /** Clear all pending (e.g., on disconnect). */
  clear(): void {
    this.pending.clear()
  }
}
