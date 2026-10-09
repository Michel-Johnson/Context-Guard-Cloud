import { lexer, Lexer } from 'marked';

const decode = value => String(value || '').replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, entity) => {
  if (entity.startsWith('#')) {
    const code = entity[1].toLowerCase() === 'x' ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : match;
  }
  return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[entity.toLowerCase()] || match;
});
const safeLink = href => /^(?:javascript|data|vbscript):/i.test(decode(href).replace(/[\u0000-\u0020\u007f]/g, '')) ? '' : decode(href);

// Only a terminal prose emphasis opener is projected without its delimiter.
// Ambiguous punctuation, escaped text and unfinished code remain literal.
function partialEmphasis(text) {
  const match = /(^|[\n：:])(\*\*|\*)(\p{L}[^*`\\\n]*)$/u.exec(text);
  if (!match || text.includes('`') || text.includes('\\')) return text;
  const [, boundary, delimiter, body] = match;
  const tokens = Lexer.lexInline(delimiter + body + delimiter, { gfm: true });
  if (tokens.length !== 1 || !['strong', 'em'].includes(tokens[0].type) || tokens[0].text !== body ||
      tokens[0].tokens?.some(token => token.type !== 'text')) return text;
  return text.slice(0, match.index) + boundary + body;
}

// Parse formatting instead of deleting punctuation indiscriminately: code,
// underscores in identifiers, URLs and ordinary arithmetic remain content.
export function plainText(source, { partial = false } = {}) {
  const input = String(source || ''), literals = [];
  let prefix = '\u0000cg-plain-literal:';
  while (input.includes(prefix)) prefix += ':';
  const literal = value => { const index = literals.push(value) - 1; return `${prefix}${index}\u0000`; };
  const slackLinks = value => value.replace(/<((?:https?:\/\/)[^>|\n]+)(?:\|([^>\n]+))?>/g,
    (_, href, label) => label ? `${label}（${href}）` : href);
  const render = (tokens, depth = 0, tail = false) => (tokens || []).map((token, index) => {
    const last = tail && index === tokens.length - 1;
    const children = (allowTail = true) => depth < 64 ? render(token.tokens, depth + 1, allowTail && last) : decode(token.text);
    switch (token.type) {
      case 'space': return '\n\n';
      case 'heading': case 'paragraph': return `${children()}\n\n`;
      case 'blockquote': return children();
      case 'strong': case 'em': case 'del': return children(false);
      case 'text': return token.tokens ? children() : decode(partial && last && tokens[index - 1]?.type !== 'escape' ? partialEmphasis(token.text) : token.text);
      case 'escape': return decode(token.text);
      case 'codespan': return literal(token.text);
      case 'code': return `${literal(token.text)}\n\n`;
      case 'br': return '\n';
      case 'hr': case 'def': return '';
      case 'link': case 'image': {
        const slack = /^<((?:https?:\/\/)[^>|\n]+)\|([^>\n]+)>$/.exec(token.raw || '');
        if (slack) return `${decode(slack[2])}（${decode(slack[1])}）`;
        const label = token.tokens ? children(false) : decode(token.text), href = safeLink(token.href);
        return href && href !== label ? `${label}（${href}）` : label || href;
      }
      case 'list': return token.items.map((item, index) => `${token.ordered ? `${Number(token.start || 1) + index}、` : '• '}${item.task ? item.checked ? '已完成：' : '待办：' : ''}${render(item.tokens, depth + 1, last && index === token.items.length - 1).trim()}`).join('\n') + '\n\n';
      case 'table': {
        const headers = token.header.map(cell => render(cell.tokens, depth + 1));
        return token.rows.map(row => row.map((cell, index) => `${headers[index]}：${render(cell.tokens, depth + 1)}`).join('；')).join('\n') + '\n\n';
      }
      case 'html': return decode(token.text.replace(/<br\s*\/?\s*>/gi, '\n').replace(/<\/?[^>]+>/g, ''));
      default: return token.tokens ? children() : decode(token.text || token.raw);
    }
  }).join('');
  let output = slackLinks(render(lexer(input, { gfm: true }), 0, true)).replace(/\n{3,}/g, '\n\n').trim();
  return output.replace(new RegExp(`${prefix}(\\d+)\u0000`, 'g'), (match, index) => literals[Number(index)] ?? match);
}

// Keep short paragraphs and code together. Oversize units split at lines,
// then words; the final fallback protects UTF-16 pairs and never drops text.
export function plainChunks(source, limit = 2800, options) {
  const value = plainText(source, options) || '—', chunks = [];
  const codeRanges = lexer(String(source || ''), { gfm: true }).filter(token => token.type === 'code')
    .map(token => { const start = value.indexOf(token.text); return { start, end: start + token.text.length }; })
    .filter(range => range.start >= 0 && range.end - range.start <= limit);
  let offset = 0;
  while (offset < value.length) {
    let end = Math.min(value.length, offset + limit);
    if (end < value.length) {
      const code = codeRanges.find(range => range.start < end && range.end > end && range.start > offset);
      if (code) end = code.start;
      else {
        const window = value.slice(offset, end), paragraph = window.lastIndexOf('\n\n'), line = window.lastIndexOf('\n');
        const boundary = paragraph > 0 ? paragraph + 2 : line > 0 ? line + 1 : window.lastIndexOf(' ') > 0 ? window.lastIndexOf(' ') + 1 : window.length;
        end = offset + boundary;
      }
      if (/^[\uDC00-\uDFFF]$/.test(value[end]) && /^[\uD800-\uDBFF]$/.test(value[end - 1])) end--;
    }
    chunks.push(value.slice(offset, end)); offset = end;
  }
  return chunks;
}
