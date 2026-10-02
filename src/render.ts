import MarkdownIt, { type Token } from 'markdown-it';

const markdown = new MarkdownIt({ html: false, linkify: false, typographer: false });
const tags = new Set(['p', 'blockquote', 'ul', 'ol', 'li', 'em', 'strong', 's', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'thead', 'tbody', 'tr', 'th', 'td']);

export function safeLink(value: string): string | null {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}

/** No HTML parsing, Obsidian postprocessors, embeds, or network-loading elements. */
export function renderMessage(content: string, target: HTMLElement): void {
  const doc = target.ownerDocument;
  const root = doc.createDocumentFragment();
  function render(tokens: Token[], parent: Node) {
    const stack: Node[] = [parent];
    for (const token of tokens) {
      const current = stack[stack.length - 1]!;
      if (token.type === 'inline') { render(token.children ?? [], current); continue; }
      if (token.type === 'image') {
        const label = doc.createElement('span');
        label.className = 'openrouter-blocked-image';
        label.textContent = `[Image blocked${token.content ? `: ${token.content}` : ''}]`;
        current.appendChild(label);
        continue;
      }
      if (token.nesting === -1) { if (stack.length > 1) stack.pop(); continue; }
      if (token.type === 'link_open') {
        const href = safeLink(String(token.attrGet('href') ?? ''));
        const link = doc.createElement(href ? 'a' : 'span');
        if (href) {
          link.setAttribute('href', href);
          link.setAttribute('target', '_blank');
          link.setAttribute('rel', 'noopener noreferrer');
          link.setAttribute('referrerpolicy', 'no-referrer');
          link.setAttribute('title', href);
        }
        current.appendChild(link);
        stack.push(link);
      } else if (token.nesting === 1) {
        const element = doc.createElement(tags.has(token.tag) ? token.tag : 'span');
        if (token.tag === 'ol' && /^\d+$/.test(String(token.attrGet('start') ?? ''))) element.setAttribute('start', String(token.attrGet('start')));
        current.appendChild(element);
        stack.push(element);
      } else if (token.type === 'fence' || token.type === 'code_block') {
        const pre = doc.createElement('pre');
        const code = doc.createElement('code');
        code.textContent = token.content;
        pre.appendChild(code);
        current.appendChild(pre);
      } else if (token.type === 'code_inline') {
        const code = doc.createElement('code');
        code.textContent = token.content;
        current.appendChild(code);
      } else if (token.type === 'hardbreak' || token.type === 'softbreak') {
        current.appendChild(doc.createElement('br'));
      } else if (token.type === 'hr') {
        current.appendChild(doc.createElement('hr'));
      } else {
        current.appendChild(doc.createTextNode(token.content));
      }
    }
  }
  render(markdown.parse(content, {}), root);
  target.replaceChildren(root);
}
