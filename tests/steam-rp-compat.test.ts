import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

interface DependencyPatch { file: string; sha256: string; before: string; after: string }
interface PatchResult { version: string; changedFiles: string[]; unchangedFiles: string[] }
interface CompatibilityModule {
  STEAM_USER_RP_PATCHES: readonly DependencyPatch[]
  patchSteamUserRichPresence(packageDirectory: string, fileOperations?: { rename(source: string, destination: string): void }): PatchResult
}
interface PresenceUser { richPresence: Record<string, string>; localizedString: string | null }
interface PresenceResponse { users: Record<string, PresenceUser> }
interface RuntimeClient {
  requestRichPresence(app: number, ids: string[] | string, language?: string | ((error: Error | null, response: PresenceResponse) => void), callback?: (error: Error | null, response: PresenceResponse) => void): Promise<PresenceResponse>
  _send: ReturnType<typeof vi.fn>
  _getRPLocalizedString: ReturnType<typeof vi.fn>
}

const project = fileURLToPath(new URL('../', import.meta.url))
const moduleUrl = new URL('../scripts/patch-steam-user-rich-presence.mjs', import.meta.url).href
const { STEAM_USER_RP_PATCHES, patchSteamUserRichPresence } = await import(moduleUrl) as CompatibilityModule
const require = createRequire(import.meta.url)
const { Root } = require('protobufjs')
const SDKMessages = require('steam-user/components/03-messages.js')
const installedPackage = join(project, 'node_modules', 'steam-user')
const SELF = '76561198000000001'
const OTHER = '76561198000000002'
const APP = 730
const folders: string[] = []
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const originals = new Map(STEAM_USER_RP_PATCHES.map(patch => {
  const installed = readFileSync(join(installedPackage, patch.file), 'utf8')
  const original = installed.includes(patch.after) ? installed.replace(patch.after, patch.before) : installed
  if (hash(original) !== patch.sha256) throw new Error(`Cannot establish the published dependency fixture: ${patch.file}`)
  return [patch.file, original]
}))
const originalLogon = readFileSync(join(installedPackage, 'components', '09-logon.js'), 'utf8')
const packageJson = readFileSync(join(installedPackage, 'package.json'), 'utf8')

afterEach(() => {
  for (const folder of folders.splice(0)) {
    expect(resolve(folder).startsWith(resolve(tmpdir()) + sep)).toBe(true)
    rmSync(folder, { recursive: true, force: true })
  }
})

function fixture(patched = true) {
  const root = mkdtempSync(join(tmpdir(), 'steam-rp-compat-'))
  folders.push(root)
  for (const [file, content] of [...originals, ['package.json', packageJson], ['components/09-logon.js', originalLogon]] as Array<[string, string]>) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), content)
  }
  if (patched) patchSteamUserRichPresence(root)
  return root
}

function method(source: string, name: string) {
  const start = source.indexOf('\t' + name + '(')
  const end = source.indexOf('\n\t/**', start)
  if (start < 0 || end < 0) throw new Error('Cannot locate dependency fixture method')
  return source.slice(start, end)
}

function harness(root: string, body: unknown) {
  const source = readFileSync(join(root, 'components', 'friends.js'), 'utf8')
  // Execute the patched public method verbatim, without constructing a CM client.
  const Client = new Function('StdLib', 'Helpers', 'EMsg', 'BinaryKVParser', 'Buffer', 'return class {' + method(source, 'requestRichPresence') + '\n}')(
    require('@doctormckay/stdlib'), require('steam-user/components/helpers.js'), require('steam-user/enums/EMsg.js'), require('binarykvparser'), Buffer
  ) as new () => RuntimeClient
  const client = new Client()
  client._send = vi.fn((_header: unknown, _payload: unknown, callback: (body: unknown) => Promise<void>) => { queueMicrotask(() => { void callback(body) }) })
  client._getRPLocalizedString = vi.fn(async () => 'Localized fixture')
  return client
}

function decode(root: string, data: Record<string, unknown>) {
  const schema = Root.fromJSON(JSON.parse(readFileSync(join(root, 'protobufs', 'generated', 'steammessages_clientserver_2.json'), 'utf8')))
  const type = schema.lookupType('CMsgClientRichPresenceInfo')
  return SDKMessages._decodeProto(type, type.encode(data).finish()) as Record<string, unknown>
}

function binary(values: Record<string, string>) {
  return binaryPairs(Object.entries(values))
}

function binaryPairs(values: Array<[string, string]>) {
  const entries = [Buffer.from([0]), Buffer.from('RP\0')]
  for (const [key, value] of values) entries.push(Buffer.from([1]), Buffer.from(key + '\0'), Buffer.from(value + '\0'))
  return Buffer.concat([...entries, Buffer.from([8, 8])])
}

function modernBody(root: string, pairs = [{ key: 'steam_display', value: '#Fixture' }, { key: 'desc', value: 'Fixture room' }, { key: 'connect', value: 'fixture-private-connection' }]) {
  return decode(root, { rich_presence: [{ steamid_user: SELF, rich_presense: pairs }] })
}

describe('version-pinned steam-user rich-presence dependency patch', () => {
  it('patches the three published files, then becomes byte-for-byte idempotent', () => {
    const root = fixture(false)
    const first = patchSteamUserRichPresence(root)
    expect(first).toEqual({ version: '5.3.0', changedFiles: STEAM_USER_RP_PATCHES.map(patch => patch.file), unchangedFiles: [] })
    const once = new Map(STEAM_USER_RP_PATCHES.map(patch => [patch.file, readFileSync(join(root, patch.file), 'utf8')]))
    expect(patchSteamUserRichPresence(root)).toEqual({ version: '5.3.0', changedFiles: [], unchangedFiles: STEAM_USER_RP_PATCHES.map(patch => patch.file) })
    for (const [file, content] of once) expect(readFileSync(join(root, file), 'utf8')).toBe(content)
  })

  it('accepts a recognized partial patch without duplicating fields', () => {
    const root = fixture(false)
    const first = STEAM_USER_RP_PATCHES[0]!
    writeFileSync(join(root, first.file), originals.get(first.file)!.replace(first.before, first.after))
    expect(patchSteamUserRichPresence(root).changedFiles).toEqual(STEAM_USER_RP_PATCHES.slice(1).map(patch => patch.file))
    expect(readFileSync(join(root, first.file), 'utf8').split('rich_presense = 3;')).toHaveLength(2)
  })

  it.each(['5.2.3', '5.3.1', '6.0.0'])('refuses unknown package version %s before writing', version => {
    const root = fixture(false)
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'steam-user', version }))
    expect(() => patchSteamUserRichPresence(root)).toThrow('exactly steam-user@5.3.0')
    for (const [file, source] of originals) expect(readFileSync(join(root, file), 'utf8')).toBe(source)
  })

  it('rejects a package with a different name even when its version matches', () => {
    const root = fixture(false)
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'another-package', version: '5.3.0' }))
    expect(() => patchSteamUserRichPresence(root)).toThrow('exactly steam-user@5.3.0')
  })

  it.each([false, true])('rejects unrelated source changes before any writes, already-patched=%s', patched => {
    const root = fixture(patched)
    const changed = STEAM_USER_RP_PATCHES.at(-1)!.file
    writeFileSync(join(root, changed), readFileSync(join(root, changed), 'utf8') + '\n// unknown change\n')
    const before = new Map(STEAM_USER_RP_PATCHES.map(patch => [patch.file, readFileSync(join(root, patch.file), 'utf8')]))
    expect(() => patchSteamUserRichPresence(root)).toThrow(/Unsupported|Unrecognized/)
    for (const [file, source] of before) expect(readFileSync(join(root, file), 'utf8')).toBe(source)
  })

  it('keeps authentication, uploads, requests, and unrelated protobuf definitions unchanged', () => {
    const root = fixture()
    expect(readFileSync(join(root, 'components', '09-logon.js'), 'utf8')).toBe(originalLogon)
    expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe(packageJson)
    const source = readFileSync(join(root, 'components', 'friends.js'), 'utf8')
    expect(method(source, 'uploadRichPresence')).toBe(method(originals.get('components/friends.js')!, 'uploadRichPresence'))
    for (const patch of STEAM_USER_RP_PATCHES) expect(readFileSync(join(root, patch.file), 'utf8').replace(patch.after, patch.before)).toBe(originals.get(patch.file))
    const original = JSON.parse(originals.get('protobufs/generated/steammessages_clientserver_2.json')!)
    const updated = JSON.parse(readFileSync(join(root, 'protobufs/generated/steammessages_clientserver_2.json'), 'utf8'))
    expect(updated.nested.CMsgClientRichPresenceUpload).toEqual(original.nested.CMsgClientRichPresenceUpload)
    expect(updated.nested.CMsgClientRichPresenceRequest).toEqual(original.nested.CMsgClientRichPresenceRequest)
    const fields = updated.nested.CMsgClientRichPresenceInfo.nested.RichPresence.fields
    expect(fields.rich_presence_kv).toEqual({ type: 'bytes', id: 2 })
    expect(fields.rich_presense).toEqual({ rule: 'repeated', type: '.CMsgClientRichPresenceInfo.KV', id: 3 })
    delete original.nested.CMsgClientRichPresenceInfo
    delete updated.nested.CMsgClientRichPresenceInfo
    expect(updated).toEqual(original)
  })

  it('stages complete files in the same directory before atomic replacement', () => {
    const root = fixture(false)
    const rename = vi.fn((source: string, destination: string) => {
      expect(dirname(source)).toBe(dirname(destination))
      expect(source).toMatch(/\.xiaolan-rp-[a-f0-9]{24}\.tmp$/)
      const patch = STEAM_USER_RP_PATCHES.find(value => join(root, value.file) === destination)!
      expect(readFileSync(source, 'utf8')).toBe(originals.get(patch.file)!.replace(patch.before, patch.after))
      renameSync(source, destination)
    })
    expect(patchSteamUserRichPresence(root, { rename }).changedFiles).toHaveLength(3)
    expect(rename).toHaveBeenCalledTimes(3)
    expect(readdirSync(root, { recursive: true, encoding: 'utf8' }).some(file => file.endsWith('.tmp'))).toBe(false)
  })

  it.each([1, 2, 3])('rolls back atomic commit failure at replacement %s and removes temporary files', failureAt => {
    const root = fixture(false)
    let calls = 0
    const rename = (source: string, destination: string) => {
      calls++
      if (calls === failureAt) throw new Error('Fixture rename failure')
      renameSync(source, destination)
    }
    expect(() => patchSteamUserRichPresence(root, { rename })).toThrow('Fixture rename failure')
    for (const [file, original] of originals) expect(readFileSync(join(root, file), 'utf8')).toBe(original)
    expect(readdirSync(root, { recursive: true, encoding: 'utf8' }).some(file => file.endsWith('.tmp'))).toBe(false)
    expect(patchSteamUserRichPresence(root).changedFiles).toHaveLength(3)
  })

  it('fails closed on rollback failure, keeping only complete recognized file versions', () => {
    const root = fixture(false)
    let calls = 0
    const rename = (source: string, destination: string) => {
      if (++calls > 1) throw new Error('Fixture persistent rename failure')
      renameSync(source, destination)
    }
    expect(() => patchSteamUserRichPresence(root, { rename })).toThrow('rollback incomplete')
    for (const patch of STEAM_USER_RP_PATCHES) {
      const content = readFileSync(join(root, patch.file), 'utf8')
      const original = originals.get(patch.file)!
      expect([original, original.replace(patch.before, patch.after)]).toContain(content)
    }
    expect(readdirSync(root, { recursive: true, encoding: 'utf8' }).some(file => file.endsWith('.tmp'))).toBe(false)
    expect(patchSteamUserRichPresence(root).changedFiles).toHaveLength(2)
  })
})

describe('production requestRichPresence dual-wire-format decoding', () => {
  it('reproduces the old schema losing new field 3 before applying compatibility', async () => {
    const root = fixture(false)
    const originalSchema = Root.fromJSON(JSON.parse(originals.get('protobufs/generated/steammessages_clientserver_2.json')!)).lookupType('CMsgClientRichPresenceInfo')
    const patched = fixture()
    const updatedSchema = Root.fromJSON(JSON.parse(readFileSync(join(patched, 'protobufs/generated/steammessages_clientserver_2.json'), 'utf8'))).lookupType('CMsgClientRichPresenceInfo')
    const wire = updatedSchema.encode({ rich_presence: [{ steamid_user: SELF, rich_presense: [{ key: 'desc', value: 'Fixture room' }] }] }).finish()
    const lost = SDKMessages._decodeProto(originalSchema, wire)
    expect(lost.rich_presence).toHaveLength(1)
    expect(lost.rich_presence[0].rich_presence_kv).toBeNull()
    expect(await harness(root, lost).requestRichPresence(APP, [SELF])).toEqual({ users: {} })
    expect((await harness(patched, SDKMessages._decodeProto(updatedSchema, wire)).requestRichPresence(APP, [SELF])).users[SELF]!.richPresence).toEqual({ desc: 'Fixture room' })
  })

  it('decodes current tag-3 KV pairs into the unchanged dictionary API, including private fields', async () => {
    const root = fixture()
    const client = harness(root, modernBody(root))
    const response = await client.requestRichPresence(APP, [SELF], 'schinese')
    expect(response.users[SELF]).toEqual({ richPresence: { steam_display: '#Fixture', desc: 'Fixture room', connect: 'fixture-private-connection' }, localizedString: 'Localized fixture' })
    expect(client._send.mock.calls[0]!.slice(0, 2)).toEqual([{ msg: 7502, proto: { routing_appid: APP } }, { steamid_request: [SELF] }])
    expect(client._getRPLocalizedString).toHaveBeenCalledExactlyOnceWith(APP, response.users[SELF]!.richPresence, 'schinese')
  })

  it('still decodes legacy tag-2 binary KV', async () => {
    const root = fixture()
    const values = { steam_display: '#Fixture', desc: 'Legacy room', connect: 'fixture-private-connection' }
    const body = decode(root, { rich_presence: [{ steamid_user: SELF, rich_presence_kv: binary(values) }] })
    expect((await harness(root, body).requestRichPresence(APP, SELF)).users[SELF]!.richPresence).toEqual(values)
  })

  it('accepts agreeing modern and legacy values regardless of key order', async () => {
    const root = fixture()
    const values = { steam_display: '#Fixture', desc: 'Matching room' }
    const body = decode(root, { rich_presence: [{ steamid_user: SELF, rich_presence_kv: binary(values), rich_presense: [{ key: 'desc', value: values.desc }, { key: 'steam_display', value: values.steam_display }] }] })
    expect((await harness(root, body).requestRichPresence(APP, [SELF])).users[SELF]!.richPresence).toEqual(values)
  })

  it('rejects contradictory modern and legacy values instead of choosing a possible false match', async () => {
    const root = fixture()
    const body = decode(root, { rich_presence: [{ steamid_user: SELF, rich_presence_kv: binary({ desc: 'Old room' }), rich_presense: [{ key: 'desc', value: 'New room' }] }] })
    expect(await harness(root, body).requestRichPresence(APP, [SELF])).toEqual({ users: {} })
  })

  it('does not hide malformed legacy data behind a valid modern representation', async () => {
    const root = fixture()
    const body = decode(root, { rich_presence: [{ steamid_user: SELF, rich_presence_kv: Buffer.from([255]), rich_presense: [{ key: 'desc', value: 'New room' }] }] })
    expect(await harness(root, body).requestRichPresence(APP, [SELF])).toEqual({ users: {} })
  })

  it('does not hide malformed modern data behind valid legacy data', async () => {
    const root = fixture()
    const body = decode(root, { rich_presence: [{ steamid_user: SELF, rich_presence_kv: binary({ desc: 'Legacy room' }), rich_presense: [{ key: 'desc', value: 'First' }, { key: 'desc', value: 'Second' }] }] })
    expect(await harness(root, body).requestRichPresence(APP, [SELF])).toEqual({ users: {} })
  })

  it('rejects legacy duplicate keys, trailing bytes, truncated strings/endings, nonstrings, and invalid UTF-8', async () => {
    const root = fixture()
    const valid = binary({ desc: 'Legacy room' })
    const invalid = [
      binaryPairs([['desc', 'First'], ['desc', 'Second']]),
      Buffer.concat([valid, Buffer.from([0])]),
      valid.subarray(0, valid.length - 1),
      Buffer.from([0, 82, 80]),
      Buffer.from([0, 82, 80, 0, 2, 100, 101, 115, 99, 0, 42, 0, 0, 0, 8, 8]),
      Buffer.from([0, 82, 80, 0, 1, 255, 0, 86, 97, 108, 117, 101, 0, 8, 8]),
      Buffer.from([0, 82, 80, 0, 1, 100, 101, 115, 99, 0, 255, 0, 8, 8]),
      binary(Object.fromEntries(Array.from({ length: 21 }, (_, index) => ['field' + index, 'Value']))),
      binary({ ['x'.repeat(64)]: 'Value' }),
      binary({ desc: 'x'.repeat(256) })
    ]
    for (const wire of invalid) {
      const body = decode(root, { rich_presence: [{ steamid_user: SELF, rich_presence_kv: wire }] })
      expect(await harness(root, body).requestRichPresence(APP, [SELF])).toEqual({ users: {} })
    }
  })

  it('does not fabricate success when both encodings are malformed', async () => {
    const root = fixture()
    const body = decode(root, { rich_presence: [{ steamid_user: SELF, rich_presence_kv: Buffer.from([255]), rich_presense: [{ key: 'desc' }] }] })
    expect(await harness(root, body).requestRichPresence(APP, [SELF])).toEqual({ users: {} })
  })

  it.each([
    [{ key: 'desc', value: 'First' }, { key: 'desc', value: 'Second' }],
    [{ value: 'Missing key' }],
    [{ key: 'desc' }],
    [{ key: '', value: 'Empty key' }],
    [{ key: 'x'.repeat(64), value: 'Long key' }],
    [{ key: 'desc', value: 'x'.repeat(256) }],
    Array.from({ length: 21 }, (_, index) => ({ key: 'field' + index, value: 'Value' }))
  ].map(pairs => ({ pairs })))('leaves malformed encoded modern data absent: %j', async ({ pairs }) => {
    const root = fixture()
    const body = decode(root, { rich_presence: [{ steamid_user: SELF, rich_presense: pairs }] })
    const client = harness(root, body)
    expect(await client.requestRichPresence(APP, [SELF])).toEqual({ users: {} })
    expect(client._getRPLocalizedString).not.toHaveBeenCalled()
  })

  it.each([
    [{ key: 'desc', value: 42 }],
    [{ key: 42, value: 'Not a string key' }],
    [{ key: 'desc', value: null }],
    [null],
    { desc: 'Not an array' }
  ].map(pairs => ({ pairs })))('rejects malformed decoded pairs without coercing values: %j', async ({ pairs }) => {
    const root = fixture()
    const body = { rich_presence: [{ steamid_user: SELF, rich_presense: pairs }] }
    expect(await harness(root, body).requestRichPresence(APP, [SELF])).toEqual({ users: {} })
  })

  it.each([null, [], { rich_presence: {} }, { rich_presence: 'invalid' }].map(body => ({ body })))('rejects a malformed response envelope: %j', async ({ body }) => {
    const root = fixture()
    await expect(harness(root, body).requestRichPresence(APP, [SELF])).rejects.toThrow('Invalid rich presence response')
  })

  it.each([{}, { rich_presence: [] }, { rich_presence: [{ steamid_user: SELF }] }])('does not fabricate a current user when no RP data exists: %j', async body => {
    const root = fixture()
    expect(await harness(root, body).requestRichPresence(APP, [SELF])).toEqual({ users: {} })
  })

  it('preserves explicit empty strings and the maximum 20 fields', async () => {
    const root = fixture()
    const pairs = Array.from({ length: 20 }, (_, index) => ({ key: 'field' + index, value: index ? 'Value' : '' }))
    const response = await harness(root, modernBody(root, pairs)).requestRichPresence(APP, [SELF])
    expect(Object.keys(response.users[SELF]!.richPresence)).toHaveLength(20)
    expect(response.users[SELF]!.richPresence.field0).toBe('')
  })

  it('measures protocol limits in UTF-8 bytes, not JavaScript code units', async () => {
    const root = fixture()
    const character = String.fromCodePoint(0x4e00)
    const key = character.repeat(21)
    const value = character.repeat(85)
    const accepted = await harness(root, modernBody(root, [{ key, value }])).requestRichPresence(APP, [SELF])
    expect(accepted.users[SELF]!.richPresence[key]).toBe(value)
    for (const pair of [{ key: key + character, value }, { key, value: value + character }]) {
      expect(await harness(root, modernBody(root, [pair])).requestRichPresence(APP, [SELF])).toEqual({ users: {} })
    }
  })

  it('rejects embedded control characters rather than forwarding truncated protocol fields', async () => {
    const root = fixture()
    for (const character of [String.fromCharCode(0), '\n', '\r', String.fromCharCode(127)]) {
      for (const pair of [{ key: 'desc' + character, value: 'Value' }, { key: 'desc', value: 'Value' + character }]) {
        expect(await harness(root, modernBody(root, [pair])).requestRichPresence(APP, [SELF])).toEqual({ users: {} })
      }
    }
  })

  it('preserves unusual complete dictionaries without prototype mutation', async () => {
    const root = fixture()
    const pairs = [{ key: '__proto__', value: 'fixture-prototype-value' }, { key: 'constructor', value: 'fixture-constructor-value' }, { key: 'connect', value: 'fixture-private-connection' }]
    const response = await harness(root, modernBody(root, pairs)).requestRichPresence(APP, [SELF])
    const values = response.users[SELF]!.richPresence
    expect(Object.getPrototypeOf(values)).toBe(Object.prototype)
    expect(Object.hasOwn(values, '__proto__')).toBe(true)
    expect(values.__proto__).toBe('fixture-prototype-value')
    expect(values.connect).toBe('fixture-private-connection')
    expect((Object.prototype as Record<string, unknown>).desc).toBeUndefined()
  })

  it('keeps valid users separate from malformed users and discards duplicate-user rows', async () => {
    const root = fixture()
    const body = decode(root, { rich_presence: [
      { steamid_user: SELF, rich_presense: [{ key: 'desc', value: 'First' }] },
      { steamid_user: OTHER, rich_presense: [{ key: 'desc', value: 'Other' }] },
      { steamid_user: SELF, rich_presense: [{ key: 'desc', value: 'Second' }] }
    ] })
    const response = await harness(root, body).requestRichPresence(APP, [SELF, OTHER])
    expect(response.users[SELF]).toBeUndefined()
    expect(response.users[OTHER]!.richPresence).toEqual({ desc: 'Other' })
  })

  it('does not discard valid data when localization is unavailable', async () => {
    const root = fixture()
    const client = harness(root, modernBody(root))
    client._getRPLocalizedString.mockRejectedValue(new Error('No fixture localization'))
    const response = await client.requestRichPresence(APP, [SELF], 'english')
    expect(response.users[SELF]!.richPresence.desc).toBe('Fixture room')
    expect(response.users[SELF]!.localizedString).toBeNull()
  })

  it('preserves the documented callback form', async () => {
    const root = fixture()
    const client = harness(root, modernBody(root))
    const response = await new Promise<PresenceResponse>((resolve, reject) => {
      void client.requestRichPresence(APP, [SELF], 'english', (error, value) => { if (error) reject(error); else resolve(value) })
    })
    expect(response.users[SELF]!.richPresence.desc).toBe('Fixture room')
  })
})
