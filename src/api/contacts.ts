import type { HttpClient } from "../http"
import type { Contact, ContactContext } from "../types"

export interface AddContactParams {
  contact_type: string
  contact_id: string
  context?: ContactContext | string
  business_id?: string
}

export function createContactsApi(http: HttpClient) {
  return {
    getContacts: (
      context?: ContactContext,
      businessId?: string,
      q?: string,
    ) => {
      const params = new URLSearchParams()
      if (context) params.set("context", context)
      if (businessId) params.set("business_id", businessId)
      if (q) params.set("q", q)
      const qs = params.toString()
      return http
        .get<{ data: Contact[] }>(`/contacts${qs ? `?${qs}` : ""}`)
        .then((r) => r.data)
    },

    addContact: (params: AddContactParams) =>
      http
        .post<{ data: { success: boolean } }>("/contacts", params)
        .then((r) => r.data),

    blockContact: (contactId: string, businessId?: string) => {
      const body: Record<string, string> = {}
      if (businessId) body.business_id = businessId
      return http
        .patch<{ data: { success: boolean } }>(`/contacts/${contactId}/block`, body)
        .then((r) => r.data)
    },

    unblockContact: (contactId: string, businessId?: string) => {
      const body: Record<string, string> = {}
      if (businessId) body.business_id = businessId
      return http
        .patch<{ data: { success: boolean } }>(`/contacts/${contactId}/unblock`, body)
        .then((r) => r.data)
    },

    deleteContact: (contactId: string, businessId?: string) => {
      const params = new URLSearchParams()
      if (businessId) params.set("business_id", businessId)
      const qs = params.toString()
      return http
        .delete<{ data: { success: boolean } }>(`/contacts/${contactId}${qs ? `?${qs}` : ""}`)
        .then((r) => r.data)
    },
  }
}
