import type { HttpClient } from "../http"
import type { Message, MessageListMeta, MessageType } from "../types"

export function createMessagesApi(http: HttpClient) {
  return {
    list: (conversationId: string, limit = 50, offset = 0) =>
      http
        .get<{
          data: Message[]
          meta: MessageListMeta
        }>(
          `/conversations/${conversationId}/messages?limit=${limit}&offset=${offset}`,
        )
        .then((r) => r),

    sendText: (conversationId: string, body: string) =>
      http
        .post<{ data: Message }>(
          `/conversations/${conversationId}/messages`,
          { body },
        )
        .then((r) => r.data),

    sendMedia: (
      conversationId: string,
      key: string,
      messageType: MessageType,
      caption?: string,
    ) =>
      http
        .post<{ data: Message }>(
          `/conversations/${conversationId}/messages/media`,
          {
            key,
            message_type: messageType,
            caption,
          },
        )
        .then((r) => r.data),
  }
}
