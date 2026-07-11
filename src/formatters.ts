export function formatTime(date: string | Date): string {
  const d = typeof date === "string" ? new Date(date) : date
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
}

export function formatDateSeparator(date: string | Date): string {
  const d = typeof date === "string" ? new Date(date) : date
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate())

  if (target.getTime() === today.getTime()) return "Today"
  if (target.getTime() === yesterday.getTime()) return "Yesterday"
  return d.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })
}

export function shouldShowDateSeparator(current: string | Date, previous: string | Date | null): boolean {
  if (!previous) return true
  const cur = typeof current === "string" ? new Date(current) : current
  const prev = typeof previous === "string" ? new Date(previous) : previous
  return (
    cur.getFullYear() !== prev.getFullYear() ||
    cur.getMonth() !== prev.getMonth() ||
    cur.getDate() !== prev.getDate()
  )
}
