export interface VdfNode {
  key: string
  value?: string
  children?: VdfNode[]
  start: number
  end: number
  close?: number
}

// Positions allow appending entries without reserializing Steam's existing metadata.
export function parseScreenshotVdf(text: string): VdfNode[] {
  if (Buffer.byteLength(text, 'utf8') > 16 * 1024 * 1024) throw new Error('VDF_TOO_LARGE')
  let position = text.charCodeAt(0) === 0xfeff ? 1 : 0
  let count = 0
  const skip = () => {
    while (position < text.length) {
      if (/\s/.test(text[position]!)) position++
      else if (text.slice(position, position + 2) === '//') {
        const end = text.indexOf('\n', position + 2)
        position = end < 0 ? text.length : end + 1
      } else break
    }
  }
  const token = (): string => {
    skip()
    if (text[position] !== '"') {
      const start = position
      while (position < text.length && !/[\s{}"]/.test(text[position]!)) position++
      if (start === position) throw new Error('VDF_EXPECTED_TOKEN')
      return text.slice(start, position)
    }
    position++
    let result = ''
    while (position < text.length) {
      const character = text[position++]!
      if (character === '"') return result
      if (character === '\\' && (text[position] === '"' || text[position] === '\\')) result += text[position++]!
      else result += character
      if (result.length > 1024 * 1024) throw new Error('VDF_TOKEN_TOO_LARGE')
    }
    throw new Error('VDF_UNTERMINATED_STRING')
  }
  const nodes = (depth: number): VdfNode[] => {
    if (depth > 32) throw new Error('VDF_TOO_DEEP')
    const result: VdfNode[] = []
    while (true) {
      skip()
      if (position >= text.length || text[position] === '}') return result
      if (++count > 150_000) throw new Error('VDF_TOO_MANY_NODES')
      const start = position
      const quotedKey = text[position] === '"'
      const key = token()
      if (!key || (!quotedKey && (key.startsWith('[') || key.startsWith('#')))) throw new Error('VDF_UNSUPPORTED_DIRECTIVE')
      skip()
      if (text[position] === '{') {
        position++
        const children = nodes(depth + 1)
        skip()
        if (text[position] !== '}') throw new Error('VDF_UNCLOSED_OBJECT')
        const close = position++
        result.push({ key, children, start, end: position, close })
      } else {
        const quotedValue = text[position] === '"'
        const value = token()
        if (!quotedValue && value.startsWith('[')) throw new Error('VDF_UNSUPPORTED_CONDITION')
        result.push({ key, value, start, end: position })
      }
    }
  }
  const result = nodes(0)
  skip()
  if (position !== text.length) throw new Error('VDF_TRAILING_DATA')
  return result
}

export function vdfChild(nodes: VdfNode[] | undefined, key: string): VdfNode | undefined {
  const matches = nodes?.filter(node => node.key.toLowerCase() === key.toLowerCase()) ?? []
  if (matches.length > 1) throw new Error('VDF_DUPLICATE_KEY')
  return matches[0]
}

export function vdfPath(nodes: VdfNode[], ...keys: string[]): VdfNode | undefined {
  let node: VdfNode | undefined
  for (const key of keys) {
    node = vdfChild(node ? node.children : nodes, key)
    if (!node) return undefined
  }
  return node
}

export function quoteVdf(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

export interface ScreenshotMetadataEntry {
  filename: string
  thumbnail: string
  width: number
  height: number
  creation: number
  caption: string
}

export function appendScreenshotMetadata(original: string | null, appId: string, entries: ScreenshotMetadataEntry[]): string {
  const text = original ?? '"screenshots"\n{\n\t"shortcutnames"\n\t{\n\t}\n}\n'
  const roots = parseScreenshotVdf(text)
  if (roots.length !== 1 || roots[0]?.key.toLowerCase() !== 'screenshots' || !roots[0].children) {
    throw new Error('VDF_SCREENSHOTS_ROOT_INVALID')
  }
  const root = roots[0]
  const game = vdfChild(root.children, appId)
  if (game && !game.children) throw new Error('VDF_SCREENSHOTS_GAME_INVALID')
  let nextIndex = 0
  const filenames = new Set<string>()
  const indexes = new Set<string>()
  for (const node of game?.children ?? []) {
    if (!/^(0|[1-9]\d*)$/.test(node.key) || !node.children) throw new Error('VDF_SCREENSHOTS_ENTRY_INVALID')
    if (indexes.has(node.key)) throw new Error('VDF_DUPLICATE_KEY')
    indexes.add(node.key)
    const index = Number(node.key)
    if (!Number.isSafeInteger(index) || index > 2_147_000_000) throw new Error('VDF_SCREENSHOTS_INDEX_INVALID')
    nextIndex = Math.max(nextIndex, index + 1)
    const filename = vdfChild(node.children, 'filename')?.value
    if (filename) filenames.add(filename.toLowerCase())
  }
  const newline = text.includes('\r\n') ? '\r\n' : '\n'
  const additions = entries.map(entry => {
    if (filenames.has(entry.filename.toLowerCase())) throw new Error('VDF_SCREENSHOT_FILENAME_COLLISION')
    filenames.add(entry.filename.toLowerCase())
    const fields: [string, string][] = [
      ['type', '1'], ['filename', entry.filename], ['thumbnail', entry.thumbnail],
      ['vrfilename', ''], ['imported', '0'], ['width', String(entry.width)], ['height', String(entry.height)],
      ['gameid', appId], ['creation', String(entry.creation)], ['caption', entry.caption],
      ['Permissions', ''], ['hscreenshot', '']
    ]
    return `\t\t"${nextIndex++}"${newline}\t\t{${newline}` + fields.map(([key, value]) =>
      `\t\t\t${quoteVdf(key)}\t\t${quoteVdf(value)}${newline}`).join('') + `\t\t}${newline}`
  }).join('')
  if (game) {
    const close = game.close!
    const lineStart = text.lastIndexOf('\n', close - 1) + 1
    const position = /^\s*$/.test(text.slice(lineStart, close)) ? lineStart : close
    return text.slice(0, position) + (position === close ? newline : '') + additions + text.slice(position)
  }
  const close = root.close!
  const lineStart = text.lastIndexOf('\n', close - 1) + 1
  const position = /^\s*$/.test(text.slice(lineStart, close)) ? lineStart : close
  return text.slice(0, position) + (position === close ? newline : '') + `\t${quoteVdf(appId)}${newline}\t{${newline}` + additions + `\t}${newline}` + text.slice(position)
}
