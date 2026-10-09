export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char] || char);
}

const allowedTags = new Set([
  'p', 'br', 'strong', 'em', 'b', 'i', 's', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'hr', 'table', 'thead', 'tbody',
  'tr', 'th', 'td', 'a',
]);

export function sanitizeMarkdownHtml(html: string): string {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const clean = (node: Node): Node | null => {
    if (node.nodeType === Node.TEXT_NODE) return document.createTextNode(node.textContent || '');
    if (node.nodeType !== Node.ELEMENT_NODE) return null;
    const source = node as Element;
    const tag = source.tagName.toLowerCase();
    if (!allowedTags.has(tag)) {
      const fragment = document.createDocumentFragment();
      if (['script', 'style', 'iframe', 'svg', 'math', 'form'].includes(tag)) return fragment;
      for (const child of Array.from(source.childNodes)) {
        const safe = clean(child);
        if (safe) fragment.appendChild(safe);
      }
      return fragment;
    }
    const element = document.createElement(tag);
    if (tag === 'a') {
      const href = source.getAttribute('href') || '';
      try {
        const url = new URL(href, document.baseURI);
        if (['http:', 'https:', 'mailto:'].includes(url.protocol)) {
          element.setAttribute('href', url.href);
          element.setAttribute('target', '_blank');
          element.setAttribute('rel', 'noopener noreferrer');
        }
      } catch { /* Invalid links remain plain text. */ }
    }
    for (const child of Array.from(source.childNodes)) {
      const safe = clean(child);
      if (safe) element.appendChild(safe);
    }
    return element;
  };
  const result = document.createElement('div');
  for (const child of Array.from(parsed.body.childNodes)) {
    const safe = clean(child);
    if (safe) result.appendChild(safe);
  }
  return result.innerHTML;
}
