import { Fragment, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { ExternalLink } from 'lucide-react'
import type { CatalogDeviceModel, DeviceModelLink } from '../../cloud/deviceModelCatalog'
import { externalUrlHostname, normalizeExternalHttpUrl, openExternalUrl } from '../../openExternalUrl'

const inlineTokenPattern = /`([^`\n]+)`|\[([^\]\n]+)\]\(([^()\n]*(?:\([^()\n]*\)[^()\n]*)*)\)/g
const emphasisPattern =
  /\*\*([^*\n]+)\*\*|(?<![A-Za-z0-9])__([^_\n]+)__(?![A-Za-z0-9])|\*([^*\n]+)\*|(?<![A-Za-z0-9])_([^_\n]+)_(?![A-Za-z0-9])/g

export function ModelMarkdown({ markdown, native }: { markdown: string; native: boolean }) {
  const normalized = markdown.replace(/\r\n/g, '\n').trim()
  if (!normalized) return null
  const blocks = parseBlocks(normalized.split('\n'), (url, event) => {
    void openExternalUrl(url, { native, event })
  })
  if (!blocks.length) return null
  return <div className="model-markdown">{blocks}</div>
}

export function ModelTagPills({ tags }: { tags: string[] }) {
  if (!tags.length) return null
  return (
    <ul className="managed-model-tags" aria-label="型号标签">
      {tags.map(tag => (
        <li key={tag}>{tag}</li>
      ))}
    </ul>
  )
}

export function ModelLinkCards({ links, native }: { links: DeviceModelLink[]; native: boolean }) {
  if (!links.length) return null
  return (
    <div className="managed-model-links" role="group" aria-label="购买与参考链接">
      {links.map((link, index) => {
        const hostname = externalUrlHostname(link.url)
        return (
          <a
            key={`${link.url}-${index}`}
            href={link.url}
            target="_blank"
            rel="noopener noreferrer"
            className="managed-model-link-card"
            onClick={event => {
              void openExternalUrl(link.url, { native, event })
            }}
          >
            <span className="managed-model-link-copy">
              <strong>{link.label}</strong>
              {hostname && <small>{hostname}</small>}
            </span>
            <ExternalLink size={14} aria-hidden="true" />
          </a>
        )
      })}
    </div>
  )
}

export function ModelCatalogBody({
  model,
  loading,
  native,
  showEmptyNote = true,
}: {
  model: CatalogDeviceModel | undefined
  loading?: boolean
  native: boolean
  showEmptyNote?: boolean
}) {
  const hasDescription = Boolean(model?.description)
  const hasLinks = Boolean(model && model.links.length > 0)
  if (!hasDescription && !hasLinks) {
    if (!showEmptyNote) return null
    return (
      <p className="managed-model-empty">
        {!model && loading ? '加载型号说明中…' : '暂无型号详细介绍，可直接继续添加设备'}
      </p>
    )
  }
  return (
    <div className="managed-catalog-detail-body">
      {hasDescription && <ModelMarkdown markdown={model!.description} native={native} />}
      {hasLinks && <ModelLinkCards links={model!.links} native={native} />}
    </div>
  )
}

function parseBlocks(
  lines: string[],
  onOpenLink: (url: string, event: ReactMouseEvent<HTMLAnchorElement>) => void,
): ReactNode[] {
  const blocks: ReactNode[] = []
  let index = 0
  while (index < lines.length) {
    const rawLine = lines[index]
    const trimmed = rawLine.trim()
    if (!trimmed) {
      index++
      continue
    }
    if (trimmed.startsWith('```')) {
      index++
      const codeLines: string[] = []
      while (index < lines.length && !lines[index].trim().startsWith('```')) {
        codeLines.push(lines[index])
        index++
      }
      if (index < lines.length) index++
      blocks.push(
        <pre key={`code-${blocks.length}`} className="model-md-code">
          <code>{codeLines.join('\n')}</code>
        </pre>,
      )
      continue
    }
    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/)
    if (headingMatch) {
      const HeadingTag = headingMatch[1].length <= 2 ? 'h4' : 'h5'
      blocks.push(
        <HeadingTag key={`h-${blocks.length}`}>
          {renderInline(headingMatch[2].trim(), `h-${blocks.length}`, onOpenLink)}
        </HeadingTag>,
      )
      index++
      continue
    }
    if (/^[-*+]\s+/.test(trimmed)) {
      const items: string[] = []
      while (index < lines.length) {
        const itemMatch = lines[index].trim().match(/^[-*+]\s+(.+)$/)
        if (!itemMatch) break
        items.push(itemMatch[1])
        index++
      }
      blocks.push(
        <ul key={`ul-${blocks.length}`}>
          {items.map((item, itemIdx) => (
            <li key={itemIdx}>{renderInline(item, `ul-${blocks.length}-${itemIdx}`, onOpenLink)}</li>
          ))}
        </ul>,
      )
      continue
    }
    if (/^\d+\.\s+/.test(trimmed)) {
      const items: string[] = []
      while (index < lines.length) {
        const itemMatch = lines[index].trim().match(/^\d+\.\s+(.+)$/)
        if (!itemMatch) break
        items.push(itemMatch[1])
        index++
      }
      blocks.push(
        <ol key={`ol-${blocks.length}`}>
          {items.map((item, itemIdx) => (
            <li key={itemIdx}>{renderInline(item, `ol-${blocks.length}-${itemIdx}`, onOpenLink)}</li>
          ))}
        </ol>,
      )
      continue
    }
    if (trimmed.startsWith('>')) {
      const quoteLines: string[] = []
      while (index < lines.length && lines[index].trim().startsWith('>')) {
        quoteLines.push(lines[index].trim().replace(/^>\s?/, ''))
        index++
      }
      const nonEmptyQuotes = quoteLines.filter(Boolean)
      if (nonEmptyQuotes.length) {
        blocks.push(
          <blockquote key={`q-${blocks.length}`}>
            {nonEmptyQuotes.map((qLine, qIdx) => (
              <Fragment key={qIdx}>
                {qIdx > 0 && <br />}
                {renderInline(qLine, `q-${blocks.length}-${qIdx}`, onOpenLink)}
              </Fragment>
            ))}
          </blockquote>,
        )
      }
      continue
    }
    const paragraphLines: string[] = []
    while (index < lines.length) {
      const current = lines[index].trim()
      if (!current || isBlockBoundary(current)) break
      paragraphLines.push(current)
      index++
    }
    blocks.push(
      <p key={`p-${blocks.length}`}>
        {paragraphLines.map((pLine, pIdx) => (
          <Fragment key={pIdx}>
            {pIdx > 0 && <br />}
            {renderInline(pLine, `p-${blocks.length}-${pIdx}`, onOpenLink)}
          </Fragment>
        ))}
      </p>,
    )
  }
  return blocks
}

function isBlockBoundary(trimmedLine: string): boolean {
  return (
    trimmedLine.startsWith('```') ||
    /^(#{1,6})\s+/.test(trimmedLine) ||
    /^[-*+]\s+/.test(trimmedLine) ||
    /^\d+\.\s+/.test(trimmedLine) ||
    trimmedLine.startsWith('>')
  )
}

function renderInline(
  text: string,
  keyPrefix: string,
  onOpenLink: (url: string, event: ReactMouseEvent<HTMLAnchorElement>) => void,
): ReactNode[] {
  const nodes: ReactNode[] = []
  let lastIndex = 0
  let tokenIndex = 0
  for (const match of text.matchAll(inlineTokenPattern)) {
    const start = match.index ?? 0
    if (start > lastIndex) {
      nodes.push(...renderEmphasis(text.slice(lastIndex, start), `${keyPrefix}-t-${tokenIndex}`))
    }
    if (match[1] !== undefined) {
      nodes.push(<code key={`${keyPrefix}-c-${tokenIndex}`}>{match[1]}</code>)
    } else {
      const label = match[2]
      const safeUrl = normalizeExternalHttpUrl(match[3])
      if (safeUrl) {
        nodes.push(
          <a
            key={`${keyPrefix}-a-${tokenIndex}`}
            href={safeUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="model-md-link"
            onClick={event => onOpenLink(safeUrl, event)}
          >
            {renderEmphasis(label, `${keyPrefix}-al-${tokenIndex}`)}
          </a>,
        )
      } else {
        nodes.push(...renderEmphasis(label, `${keyPrefix}-ul-${tokenIndex}`))
      }
    }
    lastIndex = start + match[0].length
    tokenIndex++
  }
  if (lastIndex < text.length) {
    nodes.push(...renderEmphasis(text.slice(lastIndex), `${keyPrefix}-end`))
  }
  return nodes
}

function renderEmphasis(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = []
  let lastIndex = 0
  let index = 0
  for (const match of text.matchAll(emphasisPattern)) {
    const start = match.index ?? 0
    if (start > lastIndex) {
      nodes.push(text.slice(lastIndex, start))
    }
    const bold = match[1] ?? match[2]
    const italic = match[3] ?? match[4]
    if (bold !== undefined) {
      nodes.push(<strong key={`${keyPrefix}-b-${index}`}>{bold}</strong>)
    } else if (italic !== undefined) {
      nodes.push(<em key={`${keyPrefix}-i-${index}`}>{italic}</em>)
    }
    lastIndex = start + match[0].length
    index++
  }
  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex))
  }
  return nodes
}
