interface BinaryNode { key: string; value?: string | number | bigint; children?: BinaryNode[] }

export function screenshotShortcutNames(data: Buffer): Map<string, string> {
  if (data.length > 16 * 1024 * 1024) throw new Error('SHORTCUTS_TOO_LARGE')
  let offset = 0
  let count = 0
  const need = (length: number) => { if (offset + length > data.length) throw new Error('SHORTCUTS_TRUNCATED') }
  const string = (): string => {
    const end = data.indexOf(0, offset)
    if (end < 0 || end - offset > 1024 * 1024) throw new Error('SHORTCUTS_INVALID_STRING')
    const value = data.toString('utf8', offset, end)
    offset = end + 1
    return value
  }
  const object = (depth: number): BinaryNode[] => {
    if (depth > 16) throw new Error('SHORTCUTS_TOO_DEEP')
    const nodes: BinaryNode[] = []
    while (offset < data.length) {
      const type = data[offset++]!
      if (type === 8) return nodes
      if (++count > 100_000) throw new Error('SHORTCUTS_TOO_MANY_NODES')
      const key = string()
      if (type === 0) nodes.push({ key, children: object(depth + 1) })
      else if (type === 1) nodes.push({ key, value: string() })
      else if (type === 2) { need(4); nodes.push({ key, value: data.readUInt32LE(offset) }); offset += 4 }
      else if (type === 3 || type === 4 || type === 6) { need(4); offset += 4 }
      else if (type === 7) { need(8); nodes.push({ key, value: data.readBigUInt64LE(offset) }); offset += 8 }
      else throw new Error('SHORTCUTS_UNSUPPORTED_TYPE')
    }
    throw new Error('SHORTCUTS_UNCLOSED_OBJECT')
  }
  const root = object(0)
  if (offset !== data.length) throw new Error('SHORTCUTS_TRAILING_DATA')
  const entries = root.find(node => node.key.toLowerCase() === 'shortcuts')?.children ?? []
  const result = new Map<string, string>()
  for (const entry of entries) {
    const appId = entry.children?.find(node => node.key.toLowerCase() === 'appid')?.value
    const name = entry.children?.find(node => node.key.toLowerCase() === 'appname')?.value
    if (typeof appId !== 'number' || typeof name !== 'string' || !appId) continue
    const clean = name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200)
    if (!clean) continue
    // Steam exposes the shortcut's app ID and its 64-bit game ID in different files.
    result.set(String(appId), clean)
    result.set(String((BigInt(appId) << 32n) | 0x02000000n), clean)
  }
  return result
}
