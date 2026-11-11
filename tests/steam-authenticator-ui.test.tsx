import type { ReactElement, ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SteamAuthenticatorApi, SteamAuthenticatorExportResult, SteamAuthenticatorSnapshot } from '../src/shared/steam-authenticator'

const hooks = vi.hoisted(() => ({ cursor: 0, slots: [] as any[], effects: [] as Array<() => void>, language: 'en' as 'zh-CN' | 'en' }))
const energy = vi.hoisted(() => ({ active: false, listeners: new Set<(value: boolean) => void>() }))
vi.mock('react', async original => {
  const react = await original<typeof import('react')>()
  return { ...react,
    useState: (initial: unknown) => {
      const index = hooks.cursor++
      if (!(index in hooks.slots)) hooks.slots[index] = typeof initial === 'function' ? initial() : initial
      return [hooks.slots[index], (value: unknown) => { hooks.slots[index] = typeof value === 'function' ? value(hooks.slots[index]) : value }]
    },
    useRef: (initial: unknown) => { const index = hooks.cursor++; return hooks.slots[index] ??= { current: initial } },
    useEffect: (effect: () => void | (() => void), dependencies: unknown[]) => {
      const index = hooks.cursor++, previous = hooks.slots[index]
      if (!previous || dependencies.some((value, item) => !Object.is(previous.dependencies[item], value))) {
        previous?.cleanup?.()
        const entry = { dependencies, cleanup: undefined as void | (() => void) }
        hooks.slots[index] = entry; hooks.effects.push(() => { entry.cleanup = effect() })
      }
    }
  }
})
vi.mock('../src/renderer/src/i18n', () => ({ useI18n: () => ({ language: hooks.language,
  t: (zh: string, en: string) => hooks.language === 'en' ? en : zh }) }))
vi.mock('../src/renderer/src/energy-saving', () => ({
  isEnergySavingActive: () => energy.active,
  subscribeEnergySaving: (listener: (value: boolean) => void) => { energy.listeners.add(listener); return () => energy.listeners.delete(listener) }
}))
import { SteamAuthenticatorPanel, authenticatorSecondsRemaining, steamAuthenticatorError } from '../src/renderer/src/components/SteamAuthenticatorPanel'
import { SteamAuthenticatorConfirmationsPanel } from '../src/renderer/src/components/SteamAuthenticatorConfirmationsPanel'
import { SteamAuthenticatorSetupPanel } from '../src/renderer/src/components/SteamAuthenticatorSetupPanel'

const NOW = Date.UTC(2026, 10, 10, 0, 0, 0)
const base: SteamAuthenticatorSnapshot = {
  secretStorageAvailable: true, timeSource: 'local', clockWarning: 'local-clock',
  entries: [{ id: 'guard-entry-A', name: 'Primary guard', steamId: '76561198000000001', code: 'ABCDE', expiresAt: NOW + 30_000, timeSource: 'local', capabilities: { hasConfirmations: false, fullBackup: false } }]
}
const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (value: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const nodes = (value: ReactNode): ReactElement<any>[] => !value || typeof value !== 'object' ? [] : Array.isArray(value)
  ? value.flatMap(nodes) : [value as ReactElement<any>, ...nodes((value as ReactElement<any>).props.children)]
const text = (value: ReactNode): string => typeof value === 'string' || typeof value === 'number' ? String(value)
  : Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text((value as ReactElement<any>).props.children) : ''

afterEach(() => {
  for (const entry of hooks.slots) entry?.cleanup?.()
  hooks.cursor = 0; hooks.slots = []; hooks.effects = []; hooks.language = 'en'
  energy.active = false; energy.listeners.clear()
  vi.useRealTimers(); vi.unstubAllGlobals()
})

async function fixture(options: { initial?: SteamAuthenticatorSnapshot; visible?: boolean; language?: 'zh-CN' | 'en'; initialPromise?: Promise<SteamAuthenticatorSnapshot>; pageHidden?: boolean } = {}) {
  vi.useFakeTimers(); vi.setSystemTime(NOW)
  const page = Object.assign(new EventTarget(), { visibilityState: options.pageHidden ? 'hidden' : 'visible' })
  vi.stubGlobal('document', page)
  hooks.language = options.language ?? 'en'
  const api = {
    state: vi.fn(async (): Promise<SteamAuthenticatorSnapshot> => options.initial ?? base),
    importFile: vi.fn(async (): Promise<SteamAuthenticatorSnapshot | null> => base),
    remove: vi.fn(async (_input: { id: string }): Promise<SteamAuthenticatorSnapshot> => ({ ...base, entries: [] })),
    syncTime: vi.fn(async (): Promise<SteamAuthenticatorSnapshot> => ({ ...base, timeSource: 'steam', clockWarning: null })),
    copyCode: vi.fn(async (_input: { id: string }): Promise<void> => undefined),
    exportFile: vi.fn(async (_input: { id: string }): Promise<SteamAuthenticatorExportResult> => ({ exported: true, kind: 'codes-only' })),
    showRecoveryCode: vi.fn(async (_input: { id: string }): Promise<{ viewed: boolean }> => ({ viewed: true }))
  } satisfies SteamAuthenticatorApi
  if (options.initialPromise) api.state.mockReturnValueOnce(options.initialPromise)
  const props: { api: SteamAuthenticatorApi; visible: boolean } = { api, visible: options.visible ?? true }
  let root: ReactElement<any>
  const render = () => { hooks.cursor = 0; root = SteamAuthenticatorPanel(props); hooks.effects.splice(0).forEach(effect => effect()); return root }
  const settle = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); render() }
  const button = (label: string) => {
    const found = nodes(root).find(node => node.type === 'button' && (text(node.props.children) === label || node.props['aria-label'] === label))
    if (!found) throw new Error(`Missing ${label}`)
    return found.props
  }
  const click = async (label: string) => { button(label).onClick(); await settle() }
  const advance = async (milliseconds: number) => { await vi.advanceTimersByTimeAsync(milliseconds); await settle() }
  render(); await settle()
  return { api, props, page, render, settle, button, click, advance, root: () => root,
    async pageVisibility(hidden: boolean) { page.visibilityState = hidden ? 'hidden' : 'visible'; page.dispatchEvent(new Event('visibilitychange')); await settle(); await settle() },
    async energySaving(active: boolean) { energy.active = active; for (const listener of energy.listeners) listener(active); await settle(); await settle() }
  }
}

describe('local Steam authenticator panel', () => {
  it.each(['zh-CN', 'en'] as const)('only reads the imported entries at entry and explains boundaries in %s', async language => {
    const f = await fixture({ language })
    expect(f.api.state).toHaveBeenCalledOnce()
    expect(f.api.importFile).not.toHaveBeenCalled(); expect(f.api.remove).not.toHaveBeenCalled()
    expect(f.api.copyCode).not.toHaveBeenCalled(); expect(f.api.syncTime).not.toHaveBeenCalled()
    expect(f.api.exportFile).not.toHaveBeenCalled()
    expect(f.api.showRecoveryCode).not.toHaveBeenCalled()
    const content = text(f.root())
    expect(content).toContain(language === 'en' ? 'excluded from ordinary data exports and diagnostic logs' : '不包含在普通数据导出或诊断日志中')
    expect(content).toContain(language === 'en' ? 'no trades are confirmed automatically' : '不会自动确认交易')
    expect(content).toContain(language === 'en' ? 'no mobile authenticator is removed' : '不会移除手机验证器')
    expect(content).toContain('ABCDE')
    expect(nodes(f.root()).filter(node => node.type === 'input' || node.type === 'textarea')).toHaveLength(0)
  })

  it('counts down locally without asking the main process for a code each second', async () => {
    const f = await fixture()
    expect(text(f.root())).toContain('Updates in 30s')
    await f.advance(3_000)
    expect(text(f.root())).toContain('Updates in 27s')
    expect(f.api.state).toHaveBeenCalledOnce()
  })

  it('offers separate tabs and carries only metadata, not codes, into the confirmation page', async () => {
    const f = await fixture()
    await f.click('Trade and market')
    const confirmation = nodes(f.root()).find(node => node.type === SteamAuthenticatorConfirmationsPanel)
    expect(confirmation).toBeDefined()
    expect(Object.keys(confirmation!.props.entries[0]).sort()).toEqual(['capabilities', 'id', 'name', 'steamId'])
    expect(JSON.stringify(confirmation!.props.entries)).not.toContain('ABCDE')
    expect(text(f.root())).not.toContain('ABCDE')
    expect(vi.getTimerCount()).toBe(0)
    await f.advance(60_000)
    expect(f.api.state).toHaveBeenCalledOnce()
  })

  it('mounts the honest enrollment guide without running code timers or starting account changes', async () => {
    const f = await fixture()
    await f.click('New authenticator')
    expect(nodes(f.root()).some(node => node.type === SteamAuthenticatorSetupPanel)).toBe(true)
    expect(text(f.root())).not.toContain('ABCDE')
    expect(vi.getTimerCount()).toBe(0)
    await f.advance(60_000)
    expect(f.api.state).toHaveBeenCalledOnce()
    expect(f.api.importFile).not.toHaveBeenCalled()
    expect(f.api.exportFile).not.toHaveBeenCalled()
    expect(f.api.copyCode).not.toHaveBeenCalled()
    await f.click('Codes and backups')
    expect(f.api.state).toHaveBeenCalledTimes(2)
  })

  it('keeps account wrapping separate from the enlarged non-wrapping five-character code', async () => {
    const f = await fixture()
    expect(f.root().props.className).toContain('steam-authenticator-panel')
    expect(nodes(f.root()).find(node => node.type === 'th' && node.props.scope === 'row')?.props.className).toBe('steam-account-name')
    expect(nodes(f.root()).find(node => node.type === 'code' && node.props['aria-label'] === 'Code for Primary guard')?.props.className).toBe('steam-authenticator-code')
    expect(nodes(f.root()).find(node => node.type === 'code' && text(node.props.children) === base.entries[0]!.steamId)?.props.className).toBe('steam-account-id')
  })

  it('requests fresh codes once when the displayed window expires', async () => {
    const f = await fixture({ initial: { ...base, entries: [{ ...base.entries[0]!, expiresAt: NOW + 5_000 }] } })
    f.api.state.mockResolvedValueOnce({ ...base, entries: [{ ...base.entries[0]!, code: 'BCDFG', expiresAt: NOW + 35_000 }] })
    await f.advance(5_000)
    expect(f.api.state).toHaveBeenCalledTimes(2)
    expect(text(f.root())).toContain('BCDFG')
    expect(text(f.root())).not.toContain('ABCDE')
    await f.advance(1_000)
    expect(f.api.state).toHaveBeenCalledTimes(2)
  })

  it('hides expired codes and does not spin a retry loop after a boundary read fails', async () => {
    const f = await fixture({ initial: { ...base, entries: [{ ...base.entries[0]!, expiresAt: NOW + 1_000 }] } })
    f.api.state.mockRejectedValueOnce({ code: 'AUTHENTICATOR_VAULT_INVALID' })
    await f.advance(1_000)
    expect(text(f.root())).not.toContain('ABCDE')
    expect(text(f.root())).toContain('Waiting for refresh')
    expect(text(f.root())).toContain('local authenticator data could not be verified')
    await f.advance(120_000)
    expect(f.api.state).toHaveBeenCalledTimes(2)
  })

  it('selects an import through the main process without accepting a file path or original document', async () => {
    const f = await fixture()
    await f.click('Import .maFile')
    expect(f.api.importFile).toHaveBeenCalledExactlyOnceWith()
    expect(text(f.root())).toContain('Authenticator imported and encrypted locally')
    expect(nodes(f.root()).filter(node => node.type === 'input' && node.props.type === 'file')).toHaveLength(0)
  })

  it('does not claim an import succeeded when the native file picker or replacement is cancelled', async () => {
    const f = await fixture()
    f.api.importFile.mockResolvedValueOnce(null)
    await f.click('Import .maFile')
    expect(text(f.root())).not.toContain('Authenticator imported and encrypted locally')
    expect(text(f.root())).toContain('Primary guard')
  })

  it('copies only by entry ID so the main process can generate the current code', async () => {
    const clipboard = { writeText: vi.fn() }
    vi.stubGlobal('navigator', { clipboard })
    const f = await fixture()
    await f.click('Copy code for Primary guard')
    expect(f.api.copyCode).toHaveBeenCalledExactlyOnceWith({ id: 'guard-entry-A' })
    expect(clipboard.writeText).not.toHaveBeenCalled()
    expect(text(f.root())).toContain('Current code copied')
  })

  it('exports only by entry ID through native confirmation and saving, never through a renderer file path', async () => {
    const f = await fixture()
    await f.click('Export sensitive authenticator backup for Primary guard')
    expect(f.api.exportFile).toHaveBeenCalledExactlyOnceWith({ id: 'guard-entry-A' })
    expect(text(f.root())).toContain('A codes-only backup was exported without confirmation material or missing recovery codes')
    expect(text(f.root())).toContain('contains unencrypted secrets')
    expect(nodes(f.root()).some(node => node.type === 'a' && node.props.download)).toBe(false)
    expect(nodes(f.root()).some(node => node.type === 'input' && node.props.type === 'file')).toBe(false)
  })

  it('does not claim an export succeeded when native confirmation or the save dialog is cancelled', async () => {
    const f = await fixture()
    f.api.exportFile.mockResolvedValueOnce({ exported: false })
    await f.click('Export sensitive authenticator backup for Primary guard')
    expect(text(f.root())).not.toContain('A codes-only backup was exported')
    expect(text(f.root())).not.toContain('The retained local authenticator material was exported')
  })

  it('requests existing recovery material only by ID for native display, not as a renderer secret', async () => {
    const f = await fixture()
    await f.click('Show saved recovery code for Primary guard in native window')
    expect(f.api.showRecoveryCode).toHaveBeenCalledExactlyOnceWith({ id: 'guard-entry-A' })
    expect(text(f.root())).toContain('viewing it does not mean a backup was saved')
    expect(nodes(f.root()).filter(node => node.type === 'textarea')).toHaveLength(0)
  })

  it('labels legacy records codes-only and explains that original material must be re-imported', async () => {
    const f = await fixture()
    expect(text(f.root())).toContain('Codes only')
    expect(text(f.root())).toContain('Re-import the original maFile')
    expect(text(f.root())).toContain('missing secrets or recovery codes are never invented')
    expect(text(f.root())).not.toContain('Local confirmation material ready')
  })

  it('distinguishes confirmation capability from incomplete recovery or backup material', async () => {
    const f = await fixture({ initial: { ...base, entries: [{ ...base.entries[0]!, capabilities: { hasConfirmations: true, fullBackup: false } }] } })
    expect(text(f.root())).toContain('Local confirmation material ready')
    expect(text(f.root())).toContain('Recovery material may be incomplete')
    expect(text(f.root())).not.toContain('Full SDA backup material')
    f.api.exportFile.mockResolvedValueOnce({ exported: true, kind: 'sda-backup' })
    await f.click('Export sensitive authenticator backup for Primary guard')
    expect(text(f.root())).toContain('The retained local authenticator material was exported without login sessions')
    expect(text(f.root())).not.toContain('Full SDA backup exported')
  })

  it('shows full-material metadata without claiming a live Steam sign-in or recovery test succeeded', async () => {
    const f = await fixture({ initial: { ...base, entries: [{ ...base.entries[0]!, capabilities: { hasConfirmations: true, fullBackup: true } }] } })
    expect(text(f.root())).toContain('Full SDA backup material')
    expect(text(f.root())).not.toContain('Successfully signed in')
    expect(text(f.root())).not.toContain('Recovery verified')
  })

  it('serializes export clicks while the native sensitive save is pending', async () => {
    const f = await fixture()
    const pending = deferred<SteamAuthenticatorExportResult>()
    f.api.exportFile.mockReturnValueOnce(pending.promise)
    const click = f.button('Export sensitive authenticator backup for Primary guard').onClick
    click(); click(); await f.settle()
    expect(f.api.exportFile).toHaveBeenCalledOnce()
    expect(f.button('Copy code for Primary guard').disabled).toBe(true)
    pending.resolve({ exported: false }); await f.settle()
    expect(f.button('Copy code for Primary guard').disabled).toBe(false)
  })

  it('preserves a native import result through focus-only energy saving without restarting the operation', async () => {
    const f = await fixture()
    const pending = deferred<SteamAuthenticatorSnapshot | null>()
    f.api.importFile.mockReturnValueOnce(pending.promise)
    await f.click('Import .maFile')
    await f.energySaving(true)
    expect(text(f.root())).not.toContain('ABCDE')
    expect(vi.getTimerCount()).toBe(0)
    await f.energySaving(false)
    pending.resolve({ ...base, entries: [{ ...base.entries[0]!, name: 'Imported via native dialog' }] }); await f.settle()
    expect(text(f.root())).toContain('Imported via native dialog')
    expect(text(f.root())).toContain('Authenticator imported and encrypted locally')
    expect(f.api.importFile).toHaveBeenCalledOnce()
    expect(f.api.state).toHaveBeenCalledOnce()
  })

  it('keeps a native export completion that arrives while focus-only energy saving is active', async () => {
    const f = await fixture()
    const pending = deferred<SteamAuthenticatorExportResult>()
    f.api.exportFile.mockReturnValueOnce(pending.promise)
    await f.click('Export sensitive authenticator backup for Primary guard')
    await f.energySaving(true)
    pending.resolve({ exported: true, kind: 'sda-backup' }); await f.settle()
    await f.energySaving(false)
    expect(text(f.root())).toContain('The retained local authenticator material was exported')
    expect(f.api.exportFile).toHaveBeenCalledOnce()
  })

  it('ignores a late export completion after leaving and reopening the panel', async () => {
    const f = await fixture()
    const pending = deferred<SteamAuthenticatorExportResult>()
    f.api.exportFile.mockReturnValueOnce(pending.promise)
    await f.click('Export sensitive authenticator backup for Primary guard')
    f.props.visible = false; f.render(); await f.settle()
    f.props.visible = true; f.render(); await f.settle()
    pending.resolve({ exported: true, kind: 'sda-backup' }); await f.settle()
    expect(text(f.root())).not.toContain('The retained local authenticator material was exported')
  })

  it('deletes only after the native result confirms the entry is gone', async () => {
    const f = await fixture()
    f.api.remove.mockResolvedValueOnce(base)
    await f.click('Remove local authenticator for Primary guard')
    expect(text(f.root())).not.toContain('The local toolbox entry was removed')
    await f.click('Remove local authenticator for Primary guard')
    expect(f.api.remove).toHaveBeenCalledWith({ id: 'guard-entry-A' })
    expect(text(f.root())).toContain('The local toolbox entry was removed; the mobile authenticator is unchanged')
    expect(text(f.root())).not.toContain('ABCDE')
  })

  it('prevents duplicate import actions while a native dialog is pending', async () => {
    const f = await fixture()
    const pending = deferred<SteamAuthenticatorSnapshot | null>()
    f.api.importFile.mockReturnValueOnce(pending.promise)
    const click = f.button('Import .maFile').onClick
    click(); click(); await f.settle()
    expect(f.api.importFile).toHaveBeenCalledOnce()
    expect(f.button('Refresh codes').disabled).toBe(true)
    pending.resolve(null); await f.settle()
    expect(f.button('Import .maFile').disabled).toBe(false)
  })

  it('syncs Steam time only on explicit click and shows honest local fallback', async () => {
    const f = await fixture()
    expect(text(f.root())).toContain('Codes use the local clock')
    f.api.syncTime.mockResolvedValueOnce({ ...base, clockWarning: 'steam-time-unavailable' })
    await f.click('Sync Steam time')
    expect(f.api.syncTime).toHaveBeenCalledOnce()
    expect(text(f.root())).toContain('Steam time synchronization is unavailable, so the local clock is used')
    await f.click('Sync Steam time')
    expect(text(f.root())).not.toContain('Codes use the local clock')
  })

  it('disables import when secure storage is unavailable without hiding the refresh recovery path', async () => {
    const f = await fixture({ initial: { ...base, entries: [], secretStorageAvailable: false } })
    expect(f.button('Import .maFile').disabled).toBe(true)
    expect(f.button('Sync Steam time').disabled).toBe(true)
    expect(f.button('Refresh codes').disabled).toBe(false)
    expect(text(f.root())).toContain('Local secure storage is unavailable')
  })

  it('does not request state or start a timer when its tab initially is hidden', async () => {
    const f = await fixture({ visible: false })
    expect(f.api.state).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    expect(text(f.root())).not.toContain('ABCDE')
    await f.advance(60_000)
    expect(f.api.state).not.toHaveBeenCalled()
  })

  it('does not request codes when the browser document initially is hidden', async () => {
    const f = await fixture({ pageHidden: true })
    expect(f.api.state).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    expect(text(f.root())).not.toContain('ABCDE')
  })

  it('clears codes and stops the timer when the tab is hidden, then reads fresh codes on return', async () => {
    const f = await fixture()
    f.props.visible = false; f.render(); await f.settle()
    expect(text(f.root())).not.toContain('ABCDE')
    expect(vi.getTimerCount()).toBe(0)
    await f.advance(60_000)
    expect(f.api.state).toHaveBeenCalledOnce()
    f.api.state.mockResolvedValueOnce({ ...base, entries: [{ ...base.entries[0]!, code: 'BCDFG', expiresAt: Date.now() + 30_000 }] })
    f.props.visible = true; f.render(); await f.settle()
    expect(f.api.state).toHaveBeenCalledTimes(2)
    expect(text(f.root())).toContain('BCDFG')
  })

  it('stops refresh and clears displayed codes on a document visibility change', async () => {
    const f = await fixture()
    await f.pageVisibility(true)
    expect(text(f.root())).not.toContain('ABCDE')
    expect(vi.getTimerCount()).toBe(0)
    await f.advance(60_000)
    expect(f.api.state).toHaveBeenCalledOnce()
    await f.pageVisibility(false)
    expect(f.api.state).toHaveBeenCalledTimes(2)
  })

  it('also stops timer and clears codes under the existing background energy-saving lifecycle', async () => {
    const f = await fixture()
    await f.energySaving(true)
    expect(text(f.root())).not.toContain('ABCDE')
    expect(vi.getTimerCount()).toBe(0)
    await f.advance(60_000)
    expect(f.api.state).toHaveBeenCalledOnce()
    await f.energySaving(false)
    expect(f.api.state).toHaveBeenCalledTimes(2)
  })

  it('ignores late state and import results after leaving and re-entering the page', async () => {
    const read = deferred<SteamAuthenticatorSnapshot>()
    const f = await fixture({ initialPromise: read.promise })
    f.props.visible = false; f.render(); await f.settle()
    read.resolve({ ...base, entries: [{ ...base.entries[0]!, name: 'Stale initial entry' }] }); await f.settle()
    expect(text(f.root())).not.toContain('Stale initial entry')
    f.props.visible = true; f.render(); await f.settle()
    const importing = deferred<SteamAuthenticatorSnapshot | null>()
    f.api.importFile.mockReturnValueOnce(importing.promise)
    await f.click('Import .maFile')
    f.props.visible = false; f.render(); await f.settle()
    f.props.visible = true; f.render(); await f.settle()
    importing.resolve({ ...base, entries: [{ ...base.entries[0]!, name: 'Stale imported entry' }] }); await f.settle()
    expect(text(f.root())).not.toContain('Stale imported entry')
    expect(text(f.root())).not.toContain('Authenticator imported and encrypted locally')
  })

  it('does not print raw backend errors, file contents, shared secrets, or unknown failure codes', async () => {
    const f = await fixture()
    f.api.importFile.mockRejectedValueOnce({ code: 'UNKNOWN_SECRET_FIXTURE', message: 'shared_secret=private-fixture path=C:/private.maFile' })
    await f.click('Import .maFile')
    expect(text(f.root())).toContain('File contents and secrets are never displayed')
    expect(text(f.root())).not.toContain('private-fixture')
    expect(text(f.root())).not.toContain('C:/private.maFile')
    expect(text(f.root())).not.toContain('UNKNOWN_SECRET_FIXTURE')
  })

  it('escapes imported names and refuses to display malformed or overlong code values', async () => {
    const f = await fixture({ initial: { ...base, entries: [{ ...base.entries[0]!, name: '<img onerror="bad()">', code: 'shared_secret=not-a-five-character-code' }] } })
    const html = renderToStaticMarkup(f.root())
    expect(html).toContain('&lt;img onerror=')
    expect(html).not.toContain('<img onerror=')
    expect(html).not.toContain('shared_secret=')
    expect(text(f.root())).toContain('Waiting for refresh')
  })
})

describe('authenticator UI time and error formatting', () => {
  it.each([[NOW + 30_000, NOW, 30], [NOW + 999, NOW, 1], [NOW, NOW, 0], [NOW - 1, NOW, 0],
    [NOW + 31_000, NOW, 0], [NaN, NOW, 0], [NOW, NaN, 0]])('formats only a live 30-second window (%s, %s)', (expiresAt, now, expected) => {
    expect(authenticatorSecondsRemaining(expiresAt, now)).toBe(expected)
  })

  it.each(['ENCRYPTED_UNSUPPORTED', 'SECRET_INVALID', 'NAME_INVALID', 'IDENTITY_INVALID', 'JSON_INVALID', 'FILE_INVALID',
    'FILE_TOO_LARGE', 'PATH_INVALID', 'FILE_UNAVAILABLE', 'FILE_CHANGED', 'STORAGE_UNAVAILABLE', 'STORAGE_FAILED',
    'VAULT_INVALID', 'VAULT_CHANGED', 'VAULT_FULL', 'IMPORT_EXPIRED', 'REPLACE_REQUIRED', 'ENTRY_NOT_FOUND',
    'TIME_INVALID', 'TIME_UNAVAILABLE', 'CLIPBOARD_FAILED', 'BUSY'])('translates stable AUTHENTICATOR_%s without echoing the code', suffix => {
    const code = `AUTHENTICATOR_${suffix}`
    const en = steamAuthenticatorError(code, (_zh, english) => english)
    const zh = steamAuthenticatorError(code, chinese => chinese)
    expect(en).not.toMatch(/\p{Script=Han}/u)
    expect(en).not.toContain(code); expect(zh).not.toContain(code)
    expect(en.endsWith('.')).toBe(false); expect(zh.endsWith('。')).toBe(false)
  })
})
