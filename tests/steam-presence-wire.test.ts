import { describe, expect, it } from 'vitest'
import { summarizeRichPresencePacket } from '../src/main/steam-presence-wire'

const SELF = '76561198000000001'
const OTHER = '76561198000000002'
const SECRET = 'synthetic-secret-never-return-this'
const empty = { rows: 0, selfPresent: false, legacyBytes: 0, newKvPairs: 0 }

function varint(input: number | bigint): Buffer {
  let value = BigInt(input)
  const bytes: number[] = []
  do {
    bytes.push(Number(value & 0x7fn) | (value > 0x7fn ? 0x80 : 0))
    value >>= 7n
  } while (value)
  return Buffer.from(bytes)
}
function tag(number: number, wire: number): Buffer { return varint(BigInt(number) * 8n + BigInt(wire)) }
function bytes(number: number, value: Buffer): Buffer { return Buffer.concat([tag(number, 2), varint(value.length), value]) }
function id(value: string): Buffer {
  const encoded = Buffer.alloc(8)
  encoded.writeBigUInt64LE(BigInt(value))
  return Buffer.concat([tag(1, 1), encoded])
}
function pair(key = 'secret-key', value = SECRET): Buffer {
  return bytes(3, Buffer.concat([bytes(1, Buffer.from(key)), bytes(2, Buffer.from(value))]))
}
function row(...fields: Buffer[]): Buffer { return bytes(1, Buffer.concat(fields)) }
function frame(body: Buffer, header: Buffer = Buffer.alloc(0), message = 0x80000000 + 7503): Buffer {
  const prefix = Buffer.alloc(8)
  prefix.writeUInt32LE(message, 0)
  prefix.writeUInt32LE(header.length, 4)
  return Buffer.concat([prefix, header, body])
}
function summary(body: Buffer) { return summarizeRichPresencePacket(frame(body), SELF) }

describe('value-free rich-presence wire summary', () => {
  it('reads the legacy bytes count without decoding their content', () => {
    expect(summary(row(id(SELF), bytes(2, Buffer.from(SECRET))))).toEqual({ rows: 1, selfPresent: true, legacyBytes: Buffer.byteLength(SECRET), newKvPairs: 0 })
  })
  it('counts new repeated pairs without exposing their keys or values', () => {
    const result = summary(row(id(SELF), pair(), pair('other-secret-key', 'other-secret-value')))
    expect(result).toEqual({ rows: 1, selfPresent: true, legacyBytes: 0, newKvPairs: 2 })
    expect(JSON.stringify(result)).not.toContain(SELF)
    expect(JSON.stringify(result)).not.toContain(SECRET)
    expect(JSON.stringify(result)).not.toContain('secret-key')
    expect(Object.keys(result!)).toEqual(['rows', 'selfPresent', 'legacyBytes', 'newKvPairs'])
  })
  it('counts both representations and handles the identity following their payload', () => {
    expect(summary(row(bytes(2, Buffer.alloc(15)), pair(), id(SELF)))).toEqual({ rows: 1, selfPresent: true, legacyBytes: 15, newKvPairs: 1 })
  })
  it('counts all rows but aggregates only the expected self rows', () => {
    expect(summary(Buffer.concat([row(id(OTHER), bytes(2, Buffer.alloc(30)), pair()), row(id(SELF), bytes(2, Buffer.alloc(2)), pair()), row(id(SELF), pair())]))).toEqual({ rows: 3, selfPresent: true, legacyBytes: 2, newKvPairs: 2 })
  })
  it('does not treat a missing ID or another user as self', () => {
    expect(summary(Buffer.concat([row(pair()), row(id(OTHER), bytes(2, Buffer.alloc(5)))]))).toEqual({ ...empty, rows: 2 })
  })
  it('accepts an empty body and empty self presence', () => {
    expect(summary(Buffer.alloc(0))).toEqual(empty)
    expect(summary(row(id(SELF)))).toEqual({ ...empty, rows: 1, selfPresent: true })
  })
  it('uses protobuf last-one-wins semantics for singular identity and legacy fields', () => {
    expect(summary(row(id(SELF), id(OTHER), pair()))).toEqual({ ...empty, rows: 1 })
    expect(summary(row(id(OTHER), id(SELF), bytes(2, Buffer.alloc(10)), bytes(2, Buffer.alloc(3))))).toEqual({ ...empty, rows: 1, selfPresent: true, legacyBytes: 3 })
  })
  it('safely skips all supported unknown wire types and excludes the header', () => {
    const unknown = Buffer.concat([tag(8, 0), varint(123), tag(9, 1), Buffer.alloc(8), bytes(10, Buffer.from(SECRET)), tag(11, 5), Buffer.alloc(4)])
    const packet = frame(Buffer.concat([unknown, row(id(SELF), unknown, pair())]), bytes(5, Buffer.from(SECRET)))
    expect(summarizeRichPresencePacket(packet, SELF)).toEqual({ ...empty, rows: 1, selfPresent: true, newKvPairs: 1 })
  })
  it('accepts a valid ten-byte uint64 unknown varint without numerical precision loss', () => {
    expect(summary(Buffer.concat([tag(2, 0), varint((1n << 64n) - 1n)]))).toEqual(empty)
  })
  it('accepts the exact fixed64 range for comparison', () => {
    const max = ((1n << 64n) - 1n).toString()
    expect(summarizeRichPresencePacket(frame(row(id(max))), max)?.selfPresent).toBe(true)
  })
  it.each(['', '-1', '1.0', '01', ' 1', '1 ', '1e17', '18446744073709551616', '9'.repeat(1000)])('rejects invalid expected identity %s', expected => {
    expect(summarizeRichPresencePacket(frame(Buffer.alloc(0)), expected)).toBeNull()
  })
  it.each([0, 1, 4, 7])('rejects a frame shorter than the prefix (%i bytes)', length => {
    expect(summarizeRichPresencePacket(Buffer.alloc(length), SELF)).toBeNull()
  })
  it('rejects non-buffer input rather than throwing', () => {
    expect(summarizeRichPresencePacket(new Uint8Array(8) as Buffer, SELF)).toBeNull()
    expect(summarizeRichPresencePacket(null as unknown as Buffer, SELF)).toBeNull()
  })
  it.each([7503, 0x80000000 + 7502, 0x80000000 + 7504])('rejects wrong message framing %i', message => {
    expect(summarizeRichPresencePacket(frame(Buffer.alloc(0), Buffer.alloc(0), message), SELF)).toBeNull()
  })
  it('rejects a header whose declared length exceeds the available bytes', () => {
    const packet = frame(Buffer.alloc(0))
    packet.writeUInt32LE(0xffffffff, 4)
    expect(summarizeRichPresencePacket(packet, SELF)).toBeNull()
  })
  it.each([
    Buffer.from([0]),
    Buffer.from([8]),
    Buffer.from([8, 0x80, 0]),
    Buffer.from([8, ...Array<number>(11).fill(0x80), 0]),
    Buffer.from([8, ...Array<number>(9).fill(0xff), 2]),
    Buffer.concat([tag(3, 1), Buffer.alloc(7)]),
    Buffer.concat([tag(3, 5), Buffer.alloc(3)]),
    Buffer.concat([tag(3, 2), varint(0xffffffff)]),
    Buffer.concat([tag(3, 2), varint((1n << 64n) - 1n)]),
    Buffer.concat([varint(1n << 32n), Buffer.from([0])]),
    tag(3, 3), tag(3, 4), tag(3, 6), tag(3, 7)
  ])('rejects malformed field encodings without returning partial results', malformed => {
    expect(summary(Buffer.concat([row(id(SELF), pair()), malformed]))).toBeNull()
    expect(summarizeRichPresencePacket(frame(Buffer.alloc(0), malformed), SELF)).toBeNull()
  })
  it.each([tag(1, 0), tag(1, 1), tag(1, 5)])('rejects a row with the wrong wire type', wrong => {
    expect(summary(Buffer.concat([wrong, Buffer.alloc(8)]))).toBeNull()
  })
  it.each([
    Buffer.from([9, 1, 2, 3]),
    Buffer.from([8, 1]),
    Buffer.from([16, 0]),
    Buffer.from([24, 0]),
    bytes(3, Buffer.from([0])),
    bytes(3, Buffer.from([10, 100]))
  ])('rejects malformed inner rows and KV messages', malformed => {
    expect(summary(row(id(SELF), malformed))).toBeNull()
  })
  it('rejects a truncated valid payload at each meaningful byte boundary', () => {
    const packet = frame(row(id(SELF), pair()))
    for (let length = 9; length < packet.length; length++) {
      expect(summarizeRichPresencePacket(packet.subarray(0, length), SELF)).toBeNull()
    }
  })
  it('bounds row counts to 100', () => {
    expect(summary(Buffer.concat(Array<Buffer>(100).fill(row(id(OTHER)))))).toEqual({ ...empty, rows: 100 })
    expect(summary(Buffer.concat(Array<Buffer>(101).fill(row(id(OTHER)))))).toBeNull()
  })
  it('bounds the shared field budget across headers, rows and KV pairs to 4096', () => {
    const one = Buffer.from([8, 0])
    expect(summary(Buffer.concat(Array<Buffer>(4096).fill(Buffer.from([16, 0]))))).toEqual(empty)
    expect(summary(Buffer.concat(Array<Buffer>(4097).fill(Buffer.from([16, 0]))))).toBeNull()
    expect(summarizeRichPresencePacket(frame(row(id(SELF), pair()), Buffer.concat(Array<Buffer>(4092).fill(one))), SELF)).toBeNull()
  })
  it('bounds packet size to 100 KiB before parsing', () => {
    const exact = frame(bytes(2, Buffer.alloc(100 * 1024 - 12)))
    expect(exact.length).toBe(100 * 1024)
    expect(summarizeRichPresencePacket(exact, SELF)).toEqual(empty)
    expect(summarizeRichPresencePacket(Buffer.concat([exact, Buffer.from([0])]), SELF)).toBeNull()
  })
  it('does not modify the input packet or expose synthetic header content', () => {
    const packet = frame(row(id(SELF), pair()), bytes(5, Buffer.from(`session-${SECRET}`)))
    const original = Buffer.from(packet)
    const result = summarizeRichPresencePacket(packet, SELF)
    expect(packet).toEqual(original)
    expect(JSON.stringify(result)).toBe('{"rows":1,"selfPresent":true,"legacyBytes":0,"newKvPairs":1}')
  })
})
