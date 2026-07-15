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

// ─── WhatsApp-style markdown parser ────────────────────────────────────────

export type MarkdownToken =
  | { type: 'text'; text: string }
  | { type: 'bold'; text: string }
  | { type: 'italic'; text: string }
  | { type: 'boldItalic'; text: string }
  | { type: 'strikethrough'; text: string }
  | { type: 'code'; text: string };

const MARKDOWN_RE = /(`[^`]+`)|(\*\*\*(.+?)\*\*\*)|(\*\*(.+?)\*\*)|(~~(.+?)~~)|(\*(.+?)\*)/g;

export function parseMarkdown(text: string): MarkdownToken[] {
  const tokens: MarkdownToken[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = MARKDOWN_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({ type: 'text', text: text.slice(lastIndex, match.index) });
    }

    if (match[1]) {
      tokens.push({ type: 'code', text: match[1].slice(1, -1) });
    } else if (match[2]) {
      tokens.push({ type: 'boldItalic', text: match[3] });
    } else if (match[4]) {
      tokens.push({ type: 'bold', text: match[5] });
    } else if (match[6]) {
      tokens.push({ type: 'strikethrough', text: match[7] });
    } else if (match[8]) {
      tokens.push({ type: 'bold', text: match[9] });
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    tokens.push({ type: 'text', text: text.slice(lastIndex) });
  }

  return tokens;
}

export function stripMarkdown(text: string): string {
  return parseMarkdown(text).map(t => t.text).join('');
}
