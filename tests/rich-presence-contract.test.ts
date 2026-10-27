import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isRichPresenceParameter, isWellFormedPresenceText, richPresenceContract as contract, richPresenceDisplayToken } from '../src/shared/rich-presence-contract'

const project = fileURLToPath(new URL('../', import.meta.url))
const generated = join(project, 'scripts', 'rich-presence-contract.generated.cs')
const compiler = join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
const folders: string[] = []
const temporary = () => { const path = mkdtempSync(join(tmpdir(), 'rp-contract-test-')); folders.push(path); return path }
const generator = await import(new URL('../scripts/generate-rich-presence-contract.mjs', import.meta.url).href) as { renderRichPresenceContract(root?: string): string; checkRichPresenceContract(root?: string): void }
afterAll(() => { for (const path of folders) { expect(resolve(path).startsWith(resolve(tmpdir()) + sep)).toBe(true); rmSync(path, { recursive: true, force: true }) } })

describe('stage-aware rich presence contract', () => {
  it('keeps catalog, renderer, Steam values and transport budgets separate and deeply immutable', () => {
    expect(contract.catalog.tokenValueUtf8Bytes).toBe(4096)
    expect(contract.render.templateUtf8Bytes).toBe(2048)
    expect(contract.presence.valueUtf8Bytes).toBe(255)
    expect(contract.catalog.jsonBytes).toBe(contract.render.catalogPayloadBytes)
    expect(contract.catalog.jsonBytes).toBeLessThan(contract.transport.catalogFrameBytes)
    for (const value of [contract, contract.catalog, contract.fieldPolicy.forbidden, contract.lookup.languages]) expect(Object.isFrozen(value)).toBe(true)
    expect(() => { (contract.catalog as { tokenCount: number }).tokenCount++ }).toThrow()
  })
  it('defines the native read allowlist independently from safe writable parameters', () => {
    expect(contract.fieldPolicy.nativeReadableKeys).toEqual(['desc', 'status', 'activity', 'details', 'state', 'currentmap', 'map', 'mode', 'score', 'matchgrouploc', 'game:state', 'game:mode', 'game:map', 'game:act', 'game:score', 'steam_display', 'steam_player_group_size'])
    expect(contract.fieldPolicy.nativeReadableKeys).not.toContain('version')
    expect(contract.fieldPolicy.nativeReadableKeys).not.toContain('unknown_public_candidate')
    expect(isRichPresenceParameter('game:objective')).toBe(true)
    expect(contract.fieldPolicy.nativeReadableKeys).not.toContain('game:objective')
  })
  it('checks generated sources without relying on a Windows compiler or platform branch', () => {
    expect(() => generator.checkRichPresenceContract()).not.toThrow()
    expect(readFileSync(generated, 'utf8').replace(/\r\n/g, '\n')).toBe(generator.renderRichPresenceContract())
    const root = temporary(); mkdirSync(join(root, 'src', 'shared'), { recursive: true }); mkdirSync(join(root, 'scripts'))
    const path = join(root, 'src', 'shared', 'rich-presence-contract.json')
    writeFileSync(path, readFileSync(join(project, 'src', 'shared', 'rich-presence-contract.json')))
    writeFileSync(join(root, 'scripts', 'rich-presence-contract.generated.cs'), generator.renderRichPresenceContract(root))
    expect(() => generator.checkRichPresenceContract(root)).not.toThrow()
    const normalized = JSON.parse(readFileSync(path, 'utf8'))
    writeFileSync(path, JSON.stringify(normalized, null, 4).replace(/\n/g, '\r\n') + '\r\n')
    expect(() => generator.checkRichPresenceContract(root)).not.toThrow()
    const changed = JSON.parse(readFileSync(path, 'utf8')); changed.catalog.tokenCount++
    writeFileSync(path, JSON.stringify(changed))
    expect(() => generator.checkRichPresenceContract(root)).toThrow('stale')
    writeFileSync(join(root, 'scripts', 'rich-presence-contract.generated.cs'), generator.renderRichPresenceContract(root))
    expect(() => generator.checkRichPresenceContract(root)).not.toThrow()
  })
  it.each(['server', 'serverName', 'invite', 'steamid', 'userid', 'url', 'endpoint', 'version', 'connect', 'ticket', 'steam_player_group', 'constructor', 'desc\n', 'desc\r'])('rejects shared unsafe parameter %s', key => { expect(isRichPresenceParameter(key)).toBe(false) })
  it.each(['matchgrouploc', 'game:mode', 'map', 'desc', '1mode', '_state'])('accepts generic safe parameter %s', key => { expect(isRichPresenceParameter(key)).toBe(true) })
  it.each(['#Ready\n', '#Ready\r', '#Ready\r\n', '#Ready\u2028', '#Ready\0', '#Ready value'])('rejects a display token with non-token suffix %j', token => { expect(richPresenceDisplayToken.test(token)).toBe(false) })
  it('accepts the same full display-token syntax used by both native paths', () => {
    expect(richPresenceDisplayToken.test('#Status_Game:mode-1.ready')).toBe(true)
    expect(richPresenceDisplayToken.test('#' + 'x'.repeat(127))).toBe(true)
    expect(richPresenceDisplayToken.test('#' + 'x'.repeat(128))).toBe(false)
  })
  it('validates Unicode scalars without imposing a presence-value length on raw catalog or render callers', () => {
    for (const text of ['\ud800', '\udc00', 'x\ud800y', '\n', '\u2028']) expect(isWellFormedPresenceText(text)).toBe(false)
    for (const text of ['😀', '魂天神社', 'x'.repeat(4096)]) expect(isWellFormedPresenceText(text)).toBe(true)
  })
  it('budgets JSON escaping for maximal public reads independently of request lines and raw text bytes', () => {
    const fields = Object.fromEntries(Array.from({ length: contract.presence.maxKeys }, (_, index) => [('field' + index).padEnd(contract.presence.keyAsciiLength, '_'), '"'.repeat(contract.presence.valueUtf8Bytes)]))
    const frame = JSON.stringify({ v: 1, requestId: 'x'.repeat(64), op: 'read', ok: true, acceptedKeys: [], mayHaveWritten: false, keyCount: contract.presence.maxKeys, fields, localizedString: '\\'.repeat(contract.presence.localizedReadUtf8Bytes), displayTokenReadable: false, verificationSource: 'local-cache', identityMatch: true, appMatch: true, loggedOn: true, gameStillSame: true })
    expect(Buffer.byteLength(frame)).toBeGreaterThan(contract.transport.requestLineBytes)
    expect(Buffer.byteLength(frame)).toBeLessThanOrEqual(contract.transport.ordinaryFrameBytes)
    expect(contract.transport.ordinaryFrameBytes).toBeLessThan(contract.transport.catalogFrameBytes)
  })
})

describe.skipIf(process.platform !== 'win32' || !existsSync(compiler))('generated C# / TypeScript contract parity without Steam', () => {
  let fixture = ''
  beforeAll(() => {
    generator.checkRichPresenceContract()
    const root = temporary(); fixture = join(root, 'contract.exe'); const main = join(root, 'main.cs')
    writeFileSync(main, `using System; internal static class ContractFixture { static int Main(string[] args) { byte[] bytes = Convert.FromBase64String(args[1]); char[] chars = new char[bytes.Length / 2]; for (int i = 0; i < chars.Length; i++) chars[i] = (char)(bytes[i * 2] | bytes[i * 2 + 1] << 8); string text = new string(chars); bool valid = args[0] == "key" ? RichPresenceContract.IsParameter(text) : args[0] == "token" ? RichPresenceContract.DisplayToken.IsMatch(text) : RichPresenceContract.IsWellFormedText(text); Console.Write(valid ? "true" : "false"); return 0; } }`)
    const result = spawnSync(compiler, ['/nologo', '/target:exe', '/platform:x64', '/warnaserror+', `/out:${fixture}`, generated, main], { windowsHide: true, encoding: 'utf8', timeout: 30000 })
    expect(result.status, result.stdout + result.stderr).toBe(0)
  })
  it.each(['desc', '1mode', 'matchgrouploc', 'version', 'serverName', 'invite', 'desc\n', 'desc\r', '#Ready', '#Ready\n', '#Ready\r', '#Status.Game:mode-1', '😀', '魂天神社', '\ud800', '\udc00'])('agrees for exact ASCII / Unicode boundary %j', text => {
    for (const op of ['key', 'token', 'text']) {
      const result = spawnSync(fixture, [op, Buffer.from(text, 'utf16le').toString('base64')], { windowsHide: true, encoding: 'utf8', timeout: 5000 })
      const expected = op === 'key' ? isRichPresenceParameter(text) : op === 'token' ? richPresenceDisplayToken.test(text) : isWellFormedPresenceText(text)
      expect(result.status).toBe(0); expect(result.stdout).toBe(String(expected))
    }
  })
})
