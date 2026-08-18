// Minimal safe-subset markdown renderer for model output. Deliberately NOT a
// full markdown engine: everything is emitted as text nodes or a tiny closed
// set of elements, so untrusted LLM text can never become HTML. Links are
// http(s)-only with rel="noopener noreferrer".

import { h } from './dom'

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g

function inlineToNodes(text: string): Node[] {
  const nodes: Node[] = []
  let cursor = 0
  for (const match of text.matchAll(INLINE)) {
    const start = match.index ?? 0
    if (start > cursor) nodes.push(document.createTextNode(text.slice(cursor, start)))
    const token = match[0]
    if (token.startsWith('**') && token.endsWith('**')) {
      nodes.push(h('strong', {}, token.slice(2, -2)))
    } else if (token.startsWith('`') && token.endsWith('`')) {
      nodes.push(h('code', {}, token.slice(1, -1)))
    } else if (token.startsWith('*') && token.endsWith('*')) {
      nodes.push(h('em', {}, token.slice(1, -1)))
    } else {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)
      if (link && /^https?:\/\//i.test(link[2]!)) {
        const anchor = h('a', { href: link[2]!, target: '_blank', rel: 'noopener noreferrer' }, link[1]!)
        nodes.push(anchor)
      } else {
        nodes.push(document.createTextNode(token))
      }
    }
    cursor = start + token.length
  }
  if (cursor < text.length) nodes.push(document.createTextNode(text.slice(cursor)))
  return nodes
}

/** Render markdown into a container. Block-level: headings, code fences,
 * lists, blockquotes, horizontal rules, paragraphs. */
export function renderMarkdown(container: HTMLElement, source: string): void {
  container.replaceChildren()
  if (!source) return

  const lines = source.split('\n')
  let i = 0

  const appendBlock = (el: HTMLElement): void => { container.append(el) }

  while (i < lines.length) {
    const line = lines[i]!

    if (/^\s*```/.test(line)) {
      const codeLines: string[] = []
      i++
      while (i < lines.length && !/^\s*```/.test(lines[i]!)) {
        codeLines.push(lines[i]!)
        i++
      }
      i++ // closing fence
      appendBlock(h('pre', {}, h('code', {}, codeLines.join('\n'))))
      continue
    }

    if (/^\s*(#{1,6})\s+/.test(line)) {
      const level = /^\s*(#{1,6})\s+/.exec(line)![1]!.length
      const heading = line.replace(/^\s*#{1,6}\s+/, '').replace(/\s*#+\s*$/, '')
      const el = h(`h${level}` as 'h1', {})
      el.append(...inlineToNodes(heading))
      appendBlock(el)
      i++
      continue
    }

    if (/^\s*>\s?/.test(line)) {
      const quoteLines: string[] = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i]!)) {
        quoteLines.push(lines[i]!.replace(/^\s*>\s?/, ''))
        i++
      }
      const blockquote = h('blockquote', {})
      blockquote.append(...inlineToNodes(quoteLines.join(' ')))
      appendBlock(blockquote)
      continue
    }

    if (/^\s*(?:-|\*|\+)\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
      const list = h('ul', {})
      while (i < lines.length && (/^\s*(?:-|\*|\+)\s+/.test(lines[i]!) || /^\s*\d+[.)]\s+/.test(lines[i]!))) {
        const item = h('li', {})
        item.append(...inlineToNodes(lines[i]!.replace(/^\s*(?:-|\*|\+|\d+[.)])\s+/, '')))
        list.append(item)
        i++
      }
      appendBlock(list)
      continue
    }

    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      appendBlock(h('hr', {}))
      i++
      continue
    }

    if (line.trim() === '') {
      i++
      continue
    }

    const paraLines: string[] = [line]
    i++
    while (i < lines.length && lines[i]!.trim() !== '' && !/^\s*(?:```|#{1,6}\s+|>\s?|(?:-|\*|\+|\d+[.)])\s+)/.test(lines[i]!)) {
      paraLines.push(lines[i]!)
      i++
    }
    const paragraph = h('p', {})
    paragraph.append(...inlineToNodes(paraLines.join(' ')))
    appendBlock(paragraph)
  }
}