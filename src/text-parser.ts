export interface MarkdownSegment {
  type: 'text' | 'bold' | 'italic' | 'strikethrough' | 'monospace' | 'link' | 'newline';
  text: string;
  url?: string;
}

function parseInline(text: string): MarkdownSegment[] {
  const segments: MarkdownSegment[] = [];
  let i = 0;

  while (i < text.length) {
    if (text[i] === '\n') {
      segments.push({ type: 'newline', text: '\n' });
      i++;
      continue;
    }

    if (text[i] === '*' && i + 1 < text.length) {
      const endBold = text.indexOf('*', i + 1);
      if (endBold > i + 1) {
        segments.push({ type: 'bold', text: text.substring(i + 1, endBold) });
        i = endBold + 1;
        continue;
      }
    }

    if (text[i] === '_' && i + 1 < text.length) {
      const endItalic = text.indexOf('_', i + 1);
      if (endItalic > i + 1) {
        segments.push({ type: 'italic', text: text.substring(i + 1, endItalic) });
        i = endItalic + 1;
        continue;
      }
    }

    if (text[i] === '~' && i + 1 < text.length) {
      const endStrike = text.indexOf('~', i + 1);
      if (endStrike > i + 1) {
        segments.push({ type: 'strikethrough', text: text.substring(i + 1, endStrike) });
        i = endStrike + 1;
        continue;
      }
    }

    if (text[i] === '`' && i + 1 < text.length) {
      const endMono = text.indexOf('`', i + 1);
      if (endMono > i + 1) {
        segments.push({ type: 'monospace', text: text.substring(i + 1, endMono) });
        i = endMono + 1;
        continue;
      }
    }

    const urlMatch = text.substring(i).match(
      /^https?:\/\/[^\s]+/,
    );
    if (urlMatch) {
      segments.push({ type: 'link', text: urlMatch[0], url: urlMatch[0] });
      i += urlMatch[0].length;
      continue;
    }

    let plainEnd = i + 1;
    while (
      plainEnd < text.length &&
      text[plainEnd] !== '\n' &&
      text[plainEnd] !== '*' &&
      text[plainEnd] !== '_' &&
      text[plainEnd] !== '~' &&
      text[plainEnd] !== '`' &&
      !text.substring(plainEnd).match(/^https?:\/\//)
    ) {
      plainEnd++;
    }
    segments.push({ type: 'text', text: text.substring(i, plainEnd) });
    i = plainEnd;
  }

  return segments;
}

export function parseMarkdown(text: string): MarkdownSegment[] {
  if (!text) return [];
  return parseInline(text);
}

export function markdownToPlainText(text: string): string {
  return parseMarkdown(text)
    .filter((s) => s.type !== 'newline')
    .map((s) => s.text)
    .join(' ');
}
