import type { HttpClient } from "../http"
import type { Contact, ContactContext } from "../types"

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
  }
}
