const RICH_PRESENCE_INFO = 7503
const PROTO_MASK = 0x80000000
const MAX_PACKET_BYTES = 100 * 1024
const MAX_ROWS = 100
const MAX_FIELDS = 4096
const MAX_UINT64 = (1n << 64n) - 1n
const INVALID_PACKET = Symbol('invalid rich-presence packet')

export interface RichPresencePacketSummary {
  rows: number
  selfPresent: boolean
  legacyBytes: number
  newKvPairs: number
}

interface FieldBudget { count: number }
interface Cursor { packet: Buffer; offset: number; end: number; budget: FieldBudget }

function readVarint(cursor: Cursor): bigint {
  let value = 0n
  for (let index = 0; index < 10; index++) {
    if (cursor.offset >= cursor.end) throw INVALID_PACKET
    const byte = cursor.packet.readUInt8(cursor.offset++)
    if (index === 9 && byte > 1) throw INVALID_PACKET
    value |= BigInt(byte & 0x7f) << BigInt(index * 7)
    if (!(byte & 0x80)) {
      if (index > 0 && byte === 0) throw INVALID_PACKET
      return value
    }
  }
  throw INVALID_PACKET
}

function readField(cursor: Cursor): { number: number; wire: number } {
  if (++cursor.budget.count > MAX_FIELDS) throw INVALID_PACKET
  const tag = readVarint(cursor)
  if (tag > 0xffffffffn || tag < 8n) throw INVALID_PACKET
  const wire = Number(tag & 7n)
  if (![0, 1, 2, 5].includes(wire)) throw INVALID_PACKET
  return { number: Number(tag >> 3n), wire }
}

function skipBytes(cursor: Cursor, length: number): void {
  if (length > cursor.end - cursor.offset) throw INVALID_PACKET
  cursor.offset += length
}

function readDelimited(cursor: Cursor): Cursor {
  const length = readVarint(cursor)
  if (length > BigInt(cursor.end - cursor.offset)) throw INVALID_PACKET
  const child = { ...cursor, end: cursor.offset + Number(length) }
  cursor.offset = child.end
  return child
}

function skipField(cursor: Cursor, wire: number): void {
  switch (wire) {
    case 0: readVarint(cursor); break
    case 1: skipBytes(cursor, 8); break
    case 2: readDelimited(cursor); break
    case 5: skipBytes(cursor, 4); break
    default: throw INVALID_PACKET
  }
}

function skipMessage(cursor: Cursor): void {
  while (cursor.offset < cursor.end) skipField(cursor, readField(cursor).wire)
}

function readRow(cursor: Cursor, expectedId: bigint, summary: RichPresencePacketSummary): void {
  let self = false
  let legacyBytes = 0
  let newKvPairs = 0
  while (cursor.offset < cursor.end) {
    const field = readField(cursor)
    if (field.number === 1) {
      if (field.wire !== 1 || cursor.end - cursor.offset < 8) throw INVALID_PACKET
      self = cursor.packet.readBigUInt64LE(cursor.offset) === expectedId
      cursor.offset += 8
    } else if (field.number === 2) {
      if (field.wire !== 2) throw INVALID_PACKET
      const legacy = readDelimited(cursor)
      legacyBytes = legacy.end - legacy.offset
    } else if (field.number === 3) {
      if (field.wire !== 2) throw INVALID_PACKET
      skipMessage(readDelimited(cursor))
      newKvPairs++
    } else {
      skipField(cursor, field.wire)
    }
  }
  if (self) {
    summary.selfPresent = true
    summary.legacyBytes += legacyBytes
    summary.newKvPairs += newKvPairs
  }
}

// The public steam-user traffic event contains the complete frame, not just its body.
// Keep this diagnostic projection value-free: no header, identifier, key or value escapes.
export function summarizeRichPresencePacket(packet: Buffer, expectedSteamId: string): RichPresencePacketSummary | null {
  if (!Buffer.isBuffer(packet) || packet.length < 8 || packet.length > MAX_PACKET_BYTES) return null
  if (typeof expectedSteamId !== 'string' || !/^(?:0|[1-9][0-9]{0,19})$/.test(expectedSteamId)) return null
  try {
    const expectedId = BigInt(expectedSteamId)
    if (expectedId > MAX_UINT64) return null
    const message = packet.readUInt32LE(0)
    if (!(message & PROTO_MASK) || (message & ~PROTO_MASK) !== RICH_PRESENCE_INFO) return null
    const headerLength = packet.readUInt32LE(4)
    if (headerLength > packet.length - 8) return null
    const budget = { count: 0 }
    skipMessage({ packet, offset: 8, end: 8 + headerLength, budget })
    const body = { packet, offset: 8 + headerLength, end: packet.length, budget }
    const summary: RichPresencePacketSummary = { rows: 0, selfPresent: false, legacyBytes: 0, newKvPairs: 0 }
    while (body.offset < body.end) {
      const field = readField(body)
      if (field.number === 1) {
        if (field.wire !== 2 || ++summary.rows > MAX_ROWS) throw INVALID_PACKET
        readRow(readDelimited(body), expectedId, summary)
      } else {
        skipField(body, field.wire)
      }
    }
    return summary
  } catch {
    return null
  }
}
