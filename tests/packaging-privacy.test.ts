import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { load } = require('js-yaml') as { load(source: string): unknown }
const { minimatch } = require('minimatch') as { minimatch(path: string, pattern: string, options?: { dot?: boolean }): boolean }
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

interface BuilderConfig {
  files: string[]
  asar: boolean
  extraResources: Array<{ from: string; to: string; filter?: string[] }>
  directories: { app?: string }
  [key: string]: unknown
}

const config = load(readFileSync(resolve(root, 'electron-builder.yml'), 'utf8')) as BuilderConfig
const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { build?: unknown; main: string }

function selected(path: string, patterns: string[]): boolean {
  const positive = patterns.filter(pattern => !pattern.startsWith('!'))
  const negative = patterns.filter(pattern => pattern.startsWith('!')).map(pattern => pattern.slice(1))
  return positive.some(pattern => minimatch(path, pattern, { dot: true })) && !negative.some(pattern => minimatch(path, pattern, { dot: true }))
}

describe('packaging privacy boundary', () => {
  it('packages only the three compiled application directories and the package manifest', () => {
    expect(config.files).toEqual(['out/main/**', 'out/preload/**', 'out/renderer/**', 'package.json'])
    expect(config.asar).toBe(true)
    expect(manifest.main).toBe('out/main/index.js')
    expect(manifest.build).toBeUndefined()
    expect(config.directories.app).toBeUndefined()
  })

  it('has no inherited config, resource glob, extra-file copy, or unpack bypass', () => {
    for (const key of ['extends', 'extraFiles', 'asarUnpack', 'beforePack', 'afterPack', 'afterSign', 'onNodeModuleFile']) expect(config[key]).toBeUndefined()
    const walk = (value: unknown, atRoot = false): void => {
      if (!value || typeof value !== 'object') return
      if (Array.isArray(value)) { for (const item of value) walk(item); return }
      for (const [key, item] of Object.entries(value)) {
        if (!atRoot && ['files', 'extraFiles', 'extraResources', 'asarUnpack'].includes(key)) throw new Error(`Unexpected platform-specific packaging override: ${key}`)
        walk(item)
      }
    }
    walk(config, true)
  })

  it.each([
    'out/main/index.js',
    'out/preload/index.cjs',
    'out/renderer/index.html',
    'out/renderer/assets/index-fixture.js',
    'out/renderer/assets/index-fixture.css',
    'package.json'
  ])('retains the required public application artifact %s', path => {
    expect(selected(path, config.files)).toBe(true)
  })

  it.each([
    'out/native-recovery-20261021/internal-x86-readonly.exe',
    'out/native-recovery-20261021/internal-x86-private-fixture.json',
    'out/native-recovery-20261021/steamclient-current-rp-map.json',
    'out/native-recovery-20261021/private-steam-crash.dmp',
    'out/friendlist-isolation-20261021/state-before.sqlite3',
    'out/friendlist-isolation-20261021/profile/Network/Cookies',
    'out/standalone-comment-live-fixture/Local Storage/leveldb/000001.log',
    'out/standalone-comment-live-fixture/Session Storage/MANIFEST-000001',
    'out/runtime-fixture/steam-friend-commenter.sqlite3-wal',
    'out/runtime-fixture/game-status-drafts.json',
    'out/runtime-fixture/accounts.json',
    'out/runtime-fixture/status-copy-preferences.json',
    'out/status-copy-live-fixture/session.json',
    'status-copy-preferences.json',
    'integrations/asf-status-copy/plugin/ASFStatusRelay.json',
    'out/.private-fixture/cookies.json',
    'diagnostics/runtime-current.jsonl',
    'dumps/steam-fixture.dmp',
    'steam-friend-commenter.sqlite3',
    'accounts.json',
    '.env'
  ])('does not select private diagnostics or runtime data %s', path => {
    expect(selected(path, config.files)).toBe(false)
  })

  it('copies only the reviewed logo and four production workers, never whole resource directories', () => {
    expect(config.extraResources).toEqual([{
      from: 'resources/screenshot-import',
      to: 'screenshot-import',
      filter: ['screenshot-import-host-x64.exe']
    }, {
      from: 'build/icon.png',
      to: 'icon.png'
    }, {
      from: 'resources/native-presence',
      to: 'native-presence',
      filter: ['worker-x86.exe', 'worker-x64.exe']
    }, {
      from: 'resources/local-app-simulation',
      to: 'local-app-simulation',
      filter: ['local-app-host-x64.exe']
    }])
    const filter = config.extraResources.find(resource => resource.to === 'native-presence')!.filter!
    for (const file of ['worker-x86.exe', 'worker-x64.exe']) expect(selected(file, filter)).toBe(true)
    for (const file of ['internal-x86-readonly.exe', 'profile.json', 'diagnostics/current.log', 'state.sqlite3', 'Cookies', '.env']) expect(selected(file, filter)).toBe(false)
    const simulation = config.extraResources.find(resource => resource.to === 'local-app-simulation')!.filter!
    expect(selected('local-app-host-x64.exe', simulation)).toBe(true)
    for (const file of ['local-app-host-test.exe', 'fake-game-host.exe', 'profile.json', 'state.sqlite3', '.env']) expect(selected(file, simulation)).toBe(false)
    const screenshots = config.extraResources.find(resource => resource.to === 'screenshot-import')!.filter!
    expect(selected('screenshot-import-host-x64.exe', screenshots)).toBe(true)
    for (const file of ['screenshot-live-probe.exe', 'screenshot-import-host-test.exe', 'ledger.json', '0.jpg', 'profile.json', 'state.sqlite3', '.env']) expect(selected(file, screenshots)).toBe(false)
    expect((config.win as { icon: string }).icon).toBe('build/icon.ico')
    expect((config.nsis as { installerIcon: string; uninstallerIcon: string }).installerIcon).toBe('build/icon.ico')
    expect((config.nsis as { installerIcon: string; uninstallerIcon: string }).uninstallerIcon).toBe('build/icon.ico')
  })
})
