import type {
  Message,
  Conversation,
  Contact,
  ChatStorage,
} from "./types"

const KV_MESSAGES = (cid: string) => `chat:messages:${cid}`
const KV_CONVERSATIONS = "chat:conversations"
const KV_CONTACTS = "chat:contacts"
const KV_ACTIVE_CONV_IDS = "chat:active_conv_ids"

export class ChatStore {
  private messages = new Map<string, Message[]>()
  private conversations = new Map<string, Conversation>()
  private contacts: Contact[] = []
  private activeConversationIds = new Set<string>()
  private storage: ChatStorage
  private loaded = false

  constructor(storage: ChatStorage) {
    this.storage = storage
  }

  // ─── Persistence ──────────────────────────────────

  async hydrate(): Promise<void> {
    if (this.loaded) return
    this.loaded = true

    const convIds = await this.storage.getItem<string[]>(KV_ACTIVE_CONV_IDS)
    if (convIds) this.activeConversationIds = new Set(convIds)

    const convs = await this.storage.getItem<Conversation[]>(KV_CONVERSATIONS)
    if (convs) {
      for (const c of convs) this.conversations.set(c.id, c)
    }

    const ct = await this.storage.getItem<Contact[]>(KV_CONTACTS)
    if (ct) this.contacts = ct

    for (const id of this.activeConversationIds) {
      const msgs = await this.storage.getItem<Message[]>(KV_MESSAGES(id))
      if (msgs) this.messages.set(id, msgs)
    }
  }

  private async persistConversations(): Promise<void> {
    await this.storage.setItem(
      KV_CONVERSATIONS,
      Array.from(this.conversations.values()),
    )
  }

  private async persistMessages(convId: string): Promise<void> {
    const msgs = this.messages.get(convId)
    if (msgs) {
      await this.storage.setItem(KV_MESSAGES(convId), msgs)
    }
  }

  private async persistActiveIds(): Promise<void> {
    await this.storage.setItem(
      KV_ACTIVE_CONV_IDS,
      Array.from(this.activeConversationIds),
    )
  }

  private async persistContacts(): Promise<void> {
    await this.storage.setItem(KV_CONTACTS, this.contacts)
  }

  // ─── Messages ─────────────────────────────────────

  getMessages(conversationId: string): Message[] {
    return this.messages.get(conversationId) ?? []
  }

  upsertMessage(conversationId: string, message: Message): void {
    const msgs = this.messages.get(conversationId) ?? []
    const idx = msgs.findIndex((m) => m.id === message.id)
    if (idx >= 0) {
      msgs[idx] = message
    } else {
      msgs.push(message)
    }
    msgs.sort((a, b) => {
      const aTime = new Date(a.inserted_at).getTime()
      const bTime = new Date(b.inserted_at).getTime()
      if (isNaN(aTime) && isNaN(bTime)) return 0
      if (isNaN(aTime)) return 1
      if (isNaN(bTime)) return -1
      if (aTime !== bTime) return aTime - bTime
      return (a.id ?? "").localeCompare(b.id ?? "")
    })
    this.messages.set(conversationId, msgs)
    this.activeConversationIds.add(conversationId)
    this.persistMessages(conversationId)
    this.persistActiveIds()
  }

  setMessages(conversationId: string, messages: Message[]): void {
    messages.sort((a, b) => {
      const aTime = new Date(a.inserted_at).getTime()
      const bTime = new Date(b.inserted_at).getTime()
      if (isNaN(aTime) && isNaN(bTime)) return 0
      if (isNaN(aTime)) return 1
      if (isNaN(bTime)) return -1
      if (aTime !== bTime) return aTime - bTime
      return (a.id ?? "").localeCompare(b.id ?? "")
    })
    this.messages.set(conversationId, messages)
    this.activeConversationIds.add(conversationId)
    this.persistMessages(conversationId)
    this.persistActiveIds()
  }

  // ─── Conversations ────────────────────────────────

  getConversations(): Conversation[] {
    return Array.from(this.conversations.values()).sort(
      (a, b) =>
        new Date(b.updated_at).getTime() -
        new Date(a.updated_at).getTime(),
    )
  }

  getConversation(id: string): Conversation | undefined {
    return this.conversations.get(id)
  }

  setConversations(convs: Conversation[]): void {
    for (const c of convs) this.conversations.set(c.id, c)
    this.persistConversations()
  }

  upsertConversation(conv: Conversation): void {
    this.conversations.set(conv.id, conv)
    this.persistConversations()
  }

  removeConversation(id: string): void {
    this.conversations.delete(id)
    this.messages.delete(id)
    this.activeConversationIds.delete(id)
    this.persistConversations()
    this.persistActiveIds()
  }

  /** Mark all messages in a conversation as read. */
  markConversationRead(conversationId: string, readerId: string): void {
    const msgs = this.messages.get(conversationId)
    if (!msgs) return
    for (const m of msgs) {
      if (m.sender_id !== readerId) {
        m.read = true
        if (m.status === "sent" || m.status === "delivered") {
          m.status = "read"
        }
      }
    }
    this.persistMessages(conversationId)
  }

  /** Mark all undelivered messages in a conversation as delivered. */
  markConversationDelivered(conversationId: string, joinerId: string): void {
    const msgs = this.messages.get(conversationId)
    if (!msgs) return
    for (const m of msgs) {
      if (m.sender_id !== joinerId && m.status === "sent") {
        m.status = "delivered"
      }
    }
    this.persistMessages(conversationId)
  }

  /** Set unread count for a conversation. */
  setUnreadCount(conversationId: string, count: number): void {
    const conv = this.conversations.get(conversationId)
    if (conv) {
      ;(conv as any).unread_count = count
      this.persistConversations()
    }
  }

  // ─── Contacts ─────────────────────────────────────

  getContacts(): Contact[] {
    return [...this.contacts]
  }

  setContacts(contacts: Contact[]): void {
    this.contacts = contacts
    this.persistContacts()
  }

  updateContactLastMessage(
    conversationId: string,
    text: string,
    sentAt: string,
  ): void {
    for (const c of this.contacts) {
      if (c.conversation_id === conversationId) {
        c.last_message = { text, sent_at: sentAt }
      }
    }
    this.persistContacts()
  }

  incrementContactUnread(conversationId: string): void {
    for (const c of this.contacts) {
      if (c.conversation_id === conversationId) {
        c.unread_count += 1
      }
    }
    this.persistContacts()
  }

  resetContactUnread(conversationId: string): void {
    for (const c of this.contacts) {
      if (c.conversation_id === conversationId) {
        c.unread_count = 0
      }
    }
    this.persistContacts()
  }

  // ─── Teardown ─────────────────────────────────────

  clear(): void {
    this.messages.clear()
    this.conversations.clear()
    this.contacts = []
    this.activeConversationIds.clear()
    this.loaded = false
    this.storage.clear()
  }
}
