/** Minimal, dependency-free HTML → text. Same altitude as slack's message
 *  rendering: engagement bodies are simple editor/email HTML, not arbitrary
 *  web pages — structure (<p>, <br>, <li>) becomes line breaks, everything
 *  else is stripped. */
export function htmlToText(html: string): string {
  let s = html;
  s = s.replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, '');
  s = s.replace(/<\s*li[^>]*>/gi, '\n- ');
  s = s.replace(/<\s*br\s*\/?\s*>/gi, '\n');
  s = s.replace(/<\s*\/(p|div|ul|ol|h[1-6]|tr|table|blockquote)\s*>/gi, '\n\n');
  s = s.replace(/<[^>]+>/g, '');
  s = s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, '&');
  const lines = s.split('\n').map((l) => l.replace(/\s+/g, ' ').trim());
  const out: string[] = [];
  let blanks = 0;
  for (const line of lines) {
    if (line === '') {
      blanks += 1;
      if (blanks > 1 || out.length === 0) continue;
    } else {
      blanks = 0;
    }
    out.push(line);
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}

export function propLines(pairs: Array<[string, string | null | undefined]>): string {
  return pairs
    .filter((p): p is [string, string] => typeof p[1] === 'string' && p[1] !== '')
    .map(([label, value]) => `**${label}:** ${value}`)
    .join('\n');
}

export function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
