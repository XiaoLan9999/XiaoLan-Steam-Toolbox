import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { compareVersions, validateVersion, verifySignedUpdateManifest } from '../src/main/update-security'
import { UPDATE_KEY_ID } from '../src/shared/update-public-key'
import { UPDATE_REPOSITORY, type SignedUpdateManifest, type UpdateManifest } from '../src/shared/update-types'

const keys = generateKeyPairSync('ed25519')
const testPublicKey = keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')

function validManifest(): UpdateManifest {
  const version = '0.4.0'
  return {
    schema: 1,
    repository: UPDATE_REPOSITORY,
    version,
    publishedAt: '2026-10-09T01:02:03.000Z',
    releaseUrl: `https://github.com/${UPDATE_REPOSITORY}/releases/tag/v${version}`,
    assets: (['setup', 'portable'] as const).map((kind) => {
      const fileName = `XiaoLan-Steam-Toolbox-${kind === 'setup' ? 'Setup' : 'Portable'}-${version}-x64.exe`
      return {
        kind,
        fileName,
        size: 100,
        sha256: 'a'.repeat(64),
        downloadUrl: `https://github.com/${UPDATE_REPOSITORY}/releases/download/v${version}/${fileName}`
      }
    })
  }
}

function signedBytes(payload: Buffer): SignedUpdateManifest {
  return { schema: 1, keyId: UPDATE_KEY_ID, payload: payload.toString('base64'), signature: sign(null, payload, keys.privateKey).toString('base64') }
}

function signed(value: unknown = validManifest()): SignedUpdateManifest {
  return signedBytes(Buffer.from(JSON.stringify(value), 'utf8'))
}

afterEach(() => vi.useRealTimers())

describe('signed update manifests', () => {
  it('accepts both packages only after signature verification with the pinned key', () => {
    vi.useFakeTimers().setSystemTime(new Date('2026-10-09T02:00:00Z'))
    expect(verifySignedUpdateManifest(signed(), testPublicKey)).toEqual(validManifest())
  })

  it('rejects altered payload bytes even when they remain valid JSON', () => {
    const envelope = signed()
    envelope.payload = Buffer.from(JSON.stringify({ ...validManifest(), version: '9.9.9' })).toString('base64')
    expect(() => verifySignedUpdateManifest(envelope, testPublicKey)).toThrow(/signature verification/)
  })

  it('rejects an altered signature', () => {
    const envelope = signed()
    const signature = Buffer.from(envelope.signature, 'base64')
    signature[0] = signature[0]! ^ 1
    envelope.signature = signature.toString('base64')
    expect(() => verifySignedUpdateManifest(envelope, testPublicKey)).toThrow(/signature verification/)
  })

  it('rejects a correctly signed payload using a different public key', () => {
    const wrongKey = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
    expect(() => verifySignedUpdateManifest(signed(), wrongKey)).toThrow(/signature verification/)
    expect(() => verifySignedUpdateManifest(signed())).toThrow(/signature verification/)
  })

  it.each([
    ['unknown key ID', { ...signed(), keyId: 'untrusted-mirror-key' }],
    ['alternate schema', { ...signed(), schema: 2 }],
    ['embedded public key', { ...signed(), publicKey: testPublicKey }],
    ['missing signature', { schema: 1, keyId: UPDATE_KEY_ID, payload: signed().payload }],
    ['array envelope', []],
    ['null envelope', null],
    ['oversized payload', { ...signed(), payload: 'A'.repeat(128 * 1024) }]
  ])('rejects %s', (_name, envelope) => {
    expect(() => verifySignedUpdateManifest(envelope, testPublicKey)).toThrow()
  })

  it('rejects whitespace and noncanonical base64 padding bits', () => {
    const envelope = signed()
    expect(() => verifySignedUpdateManifest({ ...envelope, payload: envelope.payload + '\n' }, testPublicKey)).toThrow(/encoding/)
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    const paddingIndex = envelope.signature.length - 3
    const alias = envelope.signature.slice(0, paddingIndex) + alphabet[alphabet.indexOf(envelope.signature[paddingIndex]!) + 1] + '=='
    expect(Buffer.from(alias, 'base64')).toEqual(Buffer.from(envelope.signature, 'base64'))
    expect(() => verifySignedUpdateManifest({ ...envelope, signature: alias }, testPublicKey)).toThrow(/encoding/)
  })

  it('rejects malformed pinned public keys and truncated signatures', () => {
    expect(() => verifySignedUpdateManifest(signed(), 'not a key')).toThrow(/encoding/)
    expect(() => verifySignedUpdateManifest({ ...signed(), signature: Buffer.alloc(63).toString('base64') }, testPublicKey)).toThrow(/signature length/)
  })

  it.each([
    Buffer.from('not JSON'),
    Buffer.from([0xc3, 0x28])
  ])('rejects signed invalid JSON or UTF-8', (payload) => {
    expect(() => verifySignedUpdateManifest(signedBytes(payload), testPublicKey)).toThrow(/manifest JSON/)
  })

  it.each([
    ['schema', (manifest: UpdateManifest) => { manifest.schema = 2 as 1 }],
    ['repository', (manifest: UpdateManifest) => { manifest.repository = 'someone/another-repository' }],
    ['prerelease version', (manifest: UpdateManifest) => { manifest.version = '0.4.0-beta.1' }],
    ['release host', (manifest: UpdateManifest) => { manifest.releaseUrl = manifest.releaseUrl.replace('github.com', 'github.com.evil.example') }],
    ['release query', (manifest: UpdateManifest) => { manifest.releaseUrl += '?redirect=evil' }],
    ['release tag', (manifest: UpdateManifest) => { manifest.releaseUrl = manifest.releaseUrl.replace('v0.4.0', 'v0.4.1') }],
    ['publication date', (manifest: UpdateManifest) => { manifest.publishedAt = '2026-02-30T01:02:03Z' }],
    ['future publication', (manifest: UpdateManifest) => { manifest.publishedAt = '2026-10-11T01:02:03Z' }],
    ['missing package', (manifest: UpdateManifest) => { manifest.assets.pop() }],
    ['duplicate package', (manifest: UpdateManifest) => { manifest.assets[1] = { ...manifest.assets[0]! } }],
    ['unknown kind', (manifest: UpdateManifest) => { manifest.assets[0]!.kind = 'script' as 'setup' }],
    ['path traversal', (manifest: UpdateManifest) => { manifest.assets[0]!.fileName = '../setup.exe' }],
    ['external download', (manifest: UpdateManifest) => { manifest.assets[0]!.downloadUrl = 'https://untrusted.example/setup.exe' }],
    ['wrong repository download', (manifest: UpdateManifest) => { manifest.assets[0]!.downloadUrl = manifest.assets[0]!.downloadUrl.replace(UPDATE_REPOSITORY, 'someone/repository') }],
    ['missing checksum', (manifest: UpdateManifest) => { delete (manifest.assets[0] as Partial<typeof manifest.assets[number]>).sha256 }],
    ['uppercase checksum', (manifest: UpdateManifest) => { manifest.assets[0]!.sha256 = 'A'.repeat(64) }],
    ['zero size', (manifest: UpdateManifest) => { manifest.assets[0]!.size = 0 }],
    ['fractional size', (manifest: UpdateManifest) => { manifest.assets[0]!.size = 1.5 }],
    ['oversized package', (manifest: UpdateManifest) => { manifest.assets[0]!.size = 512 * 1024 * 1024 + 1 }]
  ])('rejects a signed payload with invalid %s', (_name, mutate) => {
    vi.useFakeTimers().setSystemTime(new Date('2026-10-09T02:00:00Z'))
    const manifest = validManifest()
    mutate(manifest)
    expect(() => verifySignedUpdateManifest(signed(manifest), testPublicKey)).toThrow()
  })

  it('rejects executable path fields from a signed mirror response', () => {
    const manifest = validManifest()
    const payload = { ...manifest, assets: [{ ...manifest.assets[0], executablePath: 'cmd.exe' }, manifest.assets[1]] }
    expect(() => verifySignedUpdateManifest(signed(payload), testPublicKey)).toThrow(/fields/)
  })
})

describe('stable version ordering', () => {
  it.each([
    ['0.4.0', '0.4.0', 0],
    ['0.10.0', '0.9.9', 1],
    ['0.4.1', '0.4.0', 1],
    ['1.0.0', '0.99.99', 1],
    ['0.4.0', '0.4.1', -1]
  ])('compares %s against %s', (a, b, expected) => {
    expect(compareVersions(a, b)).toBe(expected)
  })

  it.each(['01.2.3', '1.02.3', '1.2.03', 'v1.2.3', '1.2', '1.2.3-beta.1', '1.2.3+build', '1.2.3\n', '9007199254740992.0.0', '', null, 123])('rejects invalid version %j', (version) => {
    expect(validateVersion(version)).toBe(false)
    expect(() => compareVersions(String(version), '0.4.0')).toThrow(/version/)
  })
})

describe('release manifest builder', () => {
  function buildFixture(args: string[], run: (result: ReturnType<typeof spawnSync>, fixtureRoot: string) => void, signingKey = keys.privateKey) {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'steam-update-builder-test-'))
    try {
      for (const folder of ['scripts', 'src/shared', 'dist']) mkdirSync(join(fixtureRoot, folder), { recursive: true })
      cpSync(fileURLToPath(new URL('../scripts/build-update-manifest.mjs', import.meta.url)), join(fixtureRoot, 'scripts/build-update-manifest.mjs'))
      writeFileSync(join(fixtureRoot, 'package.json'), JSON.stringify({ version: '0.4.0' }))
      writeFileSync(join(fixtureRoot, 'src/shared/update-public-key.ts'), `export const UPDATE_KEY_ID = '${UPDATE_KEY_ID}'\nexport const UPDATE_PUBLIC_KEY = '${testPublicKey}'\n`)
      for (const kind of ['Setup', 'Portable']) writeFileSync(join(fixtureRoot, `dist/XiaoLan-Steam-Toolbox-${kind}-0.4.0-x64.exe`), `synthetic-${kind}-package`)
      const result = spawnSync(process.execPath, [join(fixtureRoot, 'scripts/build-update-manifest.mjs'), ...args], {
        cwd: fixtureRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          GITHUB_REF_NAME: 'main',
          GITHUB_REF_TYPE: 'branch',
          UPDATE_SIGNING_PRIVATE_KEY: signingKey.export({ format: 'pem', type: 'pkcs8' }).toString()
        },
        windowsHide: true
      })
      run(result, fixtureRoot)
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true })
    }
  }

  it('signs exact package sizes and hashes, writes only public release metadata, and accepts dispatch from main', () => {
    buildFixture([], (result, fixtureRoot) => {
      expect(result.status, String(result.stderr)).toBe(0)
      const envelope = JSON.parse(readFileSync(join(fixtureRoot, 'dist/update-manifest.json'), 'utf8'))
      const manifest = verifySignedUpdateManifest(envelope, testPublicKey)
      expect(manifest.version).toBe('0.4.0')
      for (const asset of manifest.assets) {
        const bytes = readFileSync(join(fixtureRoot, 'dist', asset.fileName))
        expect(asset.size).toBe(bytes.length)
        expect(asset.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
        expect(readFileSync(join(fixtureRoot, 'dist/SHA256SUMS.txt'), 'utf8')).toContain(`${asset.sha256}  ${asset.fileName}`)
      }
      expect(readdirSync(join(fixtureRoot, 'dist')).sort()).toEqual([
        'SHA256SUMS.txt',
        'XiaoLan-Steam-Toolbox-Portable-0.4.0-x64.exe',
        'XiaoLan-Steam-Toolbox-Setup-0.4.0-x64.exe',
        'update-manifest.json'
      ])
      const privateKeyText = keys.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
      expect(String(result.stdout) + String(result.stderr)).not.toContain(privateKeyText)
      expect(readFileSync(join(fixtureRoot, 'dist/update-manifest.json'), 'utf8')).not.toContain(privateKeyText)
    })
  })

  it('refuses a mismatched release tag without producing a manifest', () => {
    buildFixture(['--tag', 'v0.4.1'], (result, fixtureRoot) => {
      expect(result.status).toBe(1)
      expect(String(result.stderr)).toMatch(/tag must exactly match/)
      expect(existsSync(join(fixtureRoot, 'dist/update-manifest.json'))).toBe(false)
    })
  })

  it('refuses a different signing key without producing a manifest', () => {
    buildFixture(['--tag', 'v0.4.0'], (result, fixtureRoot) => {
      expect(result.status).toBe(1)
      expect(String(result.stderr)).toMatch(/does not match/)
      expect(existsSync(join(fixtureRoot, 'dist/update-manifest.json'))).toBe(false)
    }, generateKeyPairSync('ed25519').privateKey)
  })
})
