import type { ReactElement, ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AccountView } from '../src/shared/types'
import type { StatusCopyApi, StatusCopyInput, StatusCopySettings, StatusCopySnapshot } from '../src/shared/status-copy'

const hooks = vi.hoisted(() => ({ cursor: 0, slots: [] as any[], effects: [] as Array<() => void>, language: 'en' }))
vi.mock('react', async original => {
  const react = await original<typeof import('react')>()
  return { ...react,
    useState: (initial: unknown) => { const index = hooks.cursor++; if (!(index in hooks.slots)) hooks.slots[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial; return [hooks.slots[index], (value: unknown) => { hooks.slots[index] = typeof value === 'function' ? (value as (previous: unknown) => unknown)(hooks.slots[index]) : value }] },
    useRef: (initial: unknown) => { const index = hooks.cursor++; return hooks.slots[index] ??= { current: initial } },
    useLayoutEffect: (effect: () => void | (() => void), dependencies: unknown[]) => { const index = hooks.cursor++; const previous = hooks.slots[index]; if (!previous || dependencies.some((value, i) => !Object.is(previous.dependencies[i], value))) { previous?.cleanup?.(); const entry = { dependencies, cleanup: undefined as void | (() => void) }; hooks.slots[index] = entry; hooks.effects.push(() => { entry.cleanup = effect() }) } }
  }
})
vi.mock('../src/renderer/src/i18n', () => ({ useI18n: () => ({ language: hooks.language, t: (zh: string, en: string) => hooks.language === 'en' ? en : zh }) }))
import { StatusCopyPanel, statusCopyError } from '../src/renderer/src/components/StatusCopyPanel'

const account = { id: 'copy-account-A', steamId: '76561198000000001', displayName: 'Target account' } as AccountView
const sourceId = '76561198000000002'
const settings: StatusCopySettings = { mode: 'toolbox', sourceSteamId: sourceId, intervalSeconds: 15, copyGroupSize: false, persona: 'away' }
const base: StatusCopySnapshot = { sessionId: 'copy-session-A', accountId: account.id, targetSteamId: account.steamId,
  phase: 'idle', busy: false, settings, error: null, source: null, targetAppId: null, appliedAt: null,
  verification: 'not-verified', waiting: false, warnings: [] }
const source = { steamId: sourceId, appId: 438100, gameName: 'Synthetic game', fields: { desc: 'Synthetic public status' }, groupSize: 4,
  observedAt: '2026-10-22T03:00:00Z', authority: 'local-source-session' as const }
const pending = <T,>() => { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const nodes = (value: ReactNode): ReactElement<any>[] => !value || typeof value !== 'object' ? [] : Array.isArray(value) ? value.flatMap(nodes) : [value as ReactElement<any>, ...nodes((value as ReactElement<any>).props.children)]
const text = (value: ReactNode): string => typeof value === 'string' || typeof value === 'number' ? String(value) : Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text((value as ReactElement<any>).props.children) : ''

afterEach(() => { for (const entry of hooks.slots) entry?.cleanup?.(); hooks.cursor = 0; hooks.slots = []; hooks.effects = []; hooks.language = 'en' })

async function fixture(options: { initial?: StatusCopySnapshot; initialPromise?: Promise<StatusCopySnapshot> } = {}) {
  let snapshot = options.initial ?? base
  const listeners = new Set<(state: StatusCopySnapshot) => void>()
  const cleanSettings = (input: StatusCopyInput): StatusCopySettings => ({ ...input.settings, asf: input.settings.asf ? { url: input.settings.asf.url, botName: input.settings.asf.botName, hasPassword: Boolean(input.settings.asf.password) } : undefined })
  const api = { state: vi.fn(() => options.initialPromise ?? Promise.resolve(snapshot)),
    save: vi.fn(async (input: StatusCopyInput): Promise<StatusCopySnapshot> => ({ ...base, settings: cleanSettings(input) })),
    preview: vi.fn(async (input: StatusCopyInput): Promise<StatusCopySnapshot> => ({ ...base, settings: cleanSettings(input), source })),
    start: vi.fn(async (input: StatusCopyInput): Promise<StatusCopySnapshot> => ({ ...base, phase: 'following', settings: cleanSettings(input), source, targetAppId: 438100, appliedAt: '2026-10-22T03:00:01Z', verification: input.settings.mode === 'asf' ? 'not-verified' : 'target-readback' })),
    stop: vi.fn(async (): Promise<StatusCopySnapshot> => ({ ...base })),
    onChange: vi.fn((listener: (state: StatusCopySnapshot) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }) } satisfies StatusCopyApi
  const props = { account, api }
  let root: ReactElement
  const render = () => { hooks.cursor = 0; root = StatusCopyPanel(props); hooks.effects.splice(0).forEach(effect => effect()); return root }
  const settle = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); render() }
  const button = (label: string) => { const value = nodes(root).find(node => node.type === 'button' && text(node) === label); if (!value) throw new Error(`Missing button ${label}`); return value.props }
  const field = (label: string) => { const value = nodes(root).find(node => ['input', 'select'].includes(String(node.type)) && node.props['aria-label'] === label); if (!value) throw new Error(`Missing field ${label}`); return value.props }
  const change = (label: string, value: string | boolean) => { field(label).onChange({ target: typeof value === 'boolean' ? { checked: value } : { value } }); render() }
  const click = async (label: string) => { button(label).onClick(); await settle() }
  render(); await settle()
  return { api, props, render, settle, button, field, change, click, root: () => root,
    emit(state: StatusCopySnapshot) { snapshot = state; for (const listener of listeners) listener(state); render() } }
}

describe('status copy UI boundaries and actions', () => {
  it('only loads state and subscribes on mount; it never implicitly signs in or starts a task', async () => {
    const f = await fixture()
    expect(f.api.state).toHaveBeenCalledOnce(); expect(f.api.onChange).toHaveBeenCalledOnce()
    expect(f.api.save).not.toHaveBeenCalled(); expect(f.api.preview).not.toHaveBeenCalled(); expect(f.api.start).not.toHaveBeenCalled(); expect(f.api.stop).not.toHaveBeenCalled()
    expect(text(f.root())).toContain('Opening this page does not sign in, start bots or write game status')
    expect(text(f.root())).toContain('Detecting the same client switching back to target ① stops following')
    expect(text(f.root())).toContain('may refresh Steam Friends')
  })
  it('saves explicit account/session settings without previewing or starting', async () => {
    const f = await fixture(); f.change('Target session persona', 'online'); f.change('Copy group size', true)
    await f.click('Save settings (do not start)')
    expect(f.api.save).toHaveBeenCalledExactlyOnceWith({ accountId: account.id, sessionId: base.sessionId,
      settings: { ...settings, persona: 'online', copyGroupSize: true } })
    expect(f.api.preview).not.toHaveBeenCalled(); expect(f.api.start).not.toHaveBeenCalled()
  })
  it('previews separately and does not turn preview into Start following', async () => {
    const f = await fixture(); await f.click('Connect and preview')
    expect(f.api.preview).toHaveBeenCalledExactlyOnceWith({ accountId: account.id, sessionId: base.sessionId, settings })
    expect(f.api.start).not.toHaveBeenCalled()
    expect(text(f.root())).toContain('Synthetic game'); expect(text(f.root())).toContain('Synthetic public status')
    expect(text(f.root())).toContain('Target-session readback is not complete')
  })
  it('shows requested target AppID and target-session readback without claiming a friend saw it', async () => {
    const f = await fixture(); await f.click('Start following')
    expect(f.api.start).toHaveBeenCalledExactlyOnceWith({ accountId: account.id, sessionId: base.sessionId, settings })
    expect(text(f.root())).toContain('Requested target AppID: 438100')
    expect(text(f.root())).toContain('Read back from the target session, not confirmed by a friend client')
    expect(f.button('Save settings (do not start)').disabled).toBe(true)
    expect(f.button('Stop / cancel').disabled).toBe(false)
  })
  it.each(['', '76561198', '765611980000000020', 'abcdefghijklmnopq', account.steamId])('blocks invalid or equal source IDs: %s', async value => {
    const f = await fixture(); f.change('Source Steam64ID', value)
    expect(f.button('Start following').disabled).toBe(true); expect(f.button('Connect and preview').disabled).toBe(true)
    await f.click('Start following'); expect(f.api.start).not.toHaveBeenCalled()
    if (value === account.steamId) expect(text(f.root())).toContain('must differ from target account')
  })
  it.each(['4', '121', '0.1', '5.5', '', 'wrong'])('rejects invalid toolbox intervals: %s', async value => {
    const f = await fixture(); f.change('Status-copy interval', value)
    expect(f.button('Save settings (do not start)').disabled).toBe(true)
    await f.click('Connect and preview'); expect(f.api.preview).not.toHaveBeenCalled()
  })
  it.each(['5', '120'])('submits toolbox interval boundary %s as a number', async value => {
    const f = await fixture(); f.change('Status-copy interval', value); await f.click('Save settings (do not start)')
    expect(f.api.save.mock.calls[0]![0].settings.intervalSeconds).toBe(Number(value))
  })
  it('checks the current draft even when a button callback came from an older render', async () => {
    const f = await fixture(); const old = f.button('Start following')
    f.field('Source Steam64ID').onChange({ target: { value: 'bad' } })
    old.onClick(); await f.settle(); expect(f.api.start).not.toHaveBeenCalled()
  })
  it('ignores foreign-account and foreign-target snapshots', async () => {
    const f = await fixture()
    f.emit({ ...base, accountId: 'other-account', source: { ...source, gameName: 'FOREIGN_ACCOUNT' } })
    f.emit({ ...base, targetSteamId: sourceId, source: { ...source, gameName: 'FOREIGN_TARGET' } })
    expect(text(f.root())).not.toContain('FOREIGN_ACCOUNT'); expect(text(f.root())).not.toContain('FOREIGN_TARGET')
  })
  it('does not let the initial state response overwrite a newer event', async () => {
    const delayed = pending<StatusCopySnapshot>(), f = await fixture({ initialPromise: delayed.promise })
    f.emit({ ...base, sessionId: 'new-event-session', phase: 'following', source: { ...source, gameName: 'NEW_EVENT_GAME' } })
    delayed.resolve({ ...base, source: { ...source, gameName: 'OLD_INITIAL_GAME' } }); await f.settle()
    expect(text(f.root())).toContain('NEW_EVENT_GAME'); expect(text(f.root())).not.toContain('OLD_INITIAL_GAME')
    await f.click('Stop / cancel'); expect(f.api.stop).toHaveBeenCalledWith({ accountId: account.id, sessionId: 'new-event-session' })
  })
  it('does not overwrite a user-edited source when initial state arrives late', async () => {
    const delayed = pending<StatusCopySnapshot>(), f = await fixture({ initialPromise: delayed.promise })
    f.change('Source Steam64ID', '76561198000000003'); delayed.resolve(base); await f.settle()
    expect(f.field('Source Steam64ID').value).toBe('76561198000000003')
  })
  it('keeps Stop available during an in-flight start and ignores the cancelled result', async () => {
    const f = await fixture(), delayed = pending<StatusCopySnapshot>()
    f.api.start.mockReturnValueOnce(delayed.promise); f.button('Start following').onClick(); await f.settle()
    expect(f.button('Stop / cancel').disabled).toBe(false); await f.click('Stop / cancel')
    delayed.resolve({ ...base, phase: 'following', source: { ...source, gameName: 'CANCELLED_GAME' } }); await f.settle()
    expect(f.api.stop).toHaveBeenCalledExactlyOnceWith({ accountId: account.id, sessionId: base.sessionId })
    expect(text(f.root())).not.toContain('CANCELLED_GAME')
  })
  it('does not revive a retired session after a later event and response', async () => {
    const f = await fixture(), delayed = pending<StatusCopySnapshot>()
    f.api.preview.mockReturnValueOnce(delayed.promise); f.button('Connect and preview').onClick(); await f.settle()
    f.emit({ ...base, sessionId: 'new-session', source: { ...source, gameName: 'CURRENT_GAME' } })
    f.emit({ ...base, source: { ...source, gameName: 'RETIRED_EVENT' } })
    delayed.resolve({ ...base, source: { ...source, gameName: 'RETIRED_RESPONSE' } }); await f.settle()
    expect(text(f.root())).toContain('CURRENT_GAME'); expect(text(f.root())).not.toContain('RETIRED_')
  })
  it('lets a newer same-session event win over a late action response', async () => {
    const f = await fixture(), delayed = pending<StatusCopySnapshot>()
    f.api.preview.mockReturnValueOnce(delayed.promise); f.button('Connect and preview').onClick(); await f.settle()
    f.emit({ ...base, source: { ...source, gameName: 'NEWER_PUSH' } })
    delayed.resolve({ ...base, source: { ...source, gameName: 'OLDER_REPLY' } }); await f.settle()
    expect(text(f.root())).toContain('NEWER_PUSH'); expect(text(f.root())).not.toContain('OLDER_REPLY')
  })
  it('ignores source changes from a pending action once the service changed source', async () => {
    const f = await fixture(), delayed = pending<StatusCopySnapshot>()
    f.api.preview.mockReturnValueOnce(delayed.promise); f.button('Connect and preview').onClick(); await f.settle()
    const changedId = '76561198000000003'
    f.emit({ ...base, settings: { ...settings, sourceSteamId: changedId }, source: { ...source, steamId: changedId, gameName: 'OTHER_SOURCE_GAME' } })
    delayed.resolve({ ...base, source: { ...source, gameName: 'OLD_SOURCE_GAME' } }); await f.settle()
    expect(f.field('Source Steam64ID').value).toBe(changedId)
    expect(text(f.root())).toContain('OTHER_SOURCE_GAME'); expect(text(f.root())).not.toContain('OLD_SOURCE_GAME')
  })
  it('ignores an old mode response after the service changed modes', async () => {
    const f = await fixture(), delayed = pending<StatusCopySnapshot>()
    f.api.preview.mockReturnValueOnce(delayed.promise); f.button('Connect and preview').onClick(); await f.settle()
    f.emit({ ...base, settings: { ...settings, mode: 'asf', asf: { url: 'http://127.0.0.1:1242', botName: 'Bot', hasPassword: false } } })
    delayed.resolve({ ...base, source: { ...source, gameName: 'OLD_TOOLBOX_MODE' } }); await f.settle()
    expect(f.field('Status-copy mode').value).toBe('asf'); expect(text(f.root())).not.toContain('OLD_TOOLBOX_MODE')
  })
  it('ignores pending results after account switches and never submits an old account handler', async () => {
    const f = await fixture(), delayed = pending<StatusCopySnapshot>()
    const oldStop = f.button('Stop / cancel')
    f.api.preview.mockReturnValueOnce(delayed.promise); f.button('Connect and preview').onClick(); await f.settle()
    f.props.account = { ...account, id: 'account-B', steamId: '76561198000000004' }; f.render(); await f.settle()
    delayed.resolve({ ...base, source: { ...source, gameName: 'OLD_ACCOUNT_GAME' } }); await f.settle()
    oldStop.onClick(); await f.settle()
    expect(text(f.root())).not.toContain('OLD_ACCOUNT_GAME'); expect(f.api.stop).not.toHaveBeenCalled()
  })
  it('does not show a preview belonging to a different selected mode or source', async () => {
    const f = await fixture({ initial: { ...base, source } })
    f.change('Source Steam64ID', '76561198000000003')
    expect(text(f.root())).not.toContain('Synthetic game'); expect(text(f.root())).not.toContain('Synthetic public status')
    f.change('Status-copy mode', 'asf'); expect(text(f.root())).not.toContain('Synthetic game')
  })
  it('escapes field markup and filters connection, room, group-ID and unknown fields', async () => {
    const f = await fixture({ initial: { ...base, source: { ...source, fields: { desc: '<script>alert(1)</script>', hero: 'SyntheticHero', connect: 'PRIVATE_CONNECT', steam_player_group: 'PRIVATE_GROUP', room: 'PRIVATE_ROOM', unknown: 'PRIVATE_UNKNOWN' } } } })
    const html = renderToStaticMarkup(f.root())
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;'); expect(html).not.toContain('<script>')
    expect(html).toContain('SyntheticHero')
    for (const secret of ['PRIVATE_CONNECT', 'PRIVATE_GROUP', 'PRIVATE_ROOM', 'PRIVATE_UNKNOWN']) expect(html).not.toContain(secret)
  })
  it('never renders raw error messages, credentials, service session IDs or unknown warning strings', async () => {
    const f = await fixture(), failure = Object.assign(new Error('PRIVATE_ERROR_MESSAGE'), { code: 'PRIVATE_ERROR_CODE', password: 'PRIVATE_PASSWORD' })
    f.api.preview.mockRejectedValueOnce(failure); await f.click('Connect and preview')
    f.emit({ ...base, warnings: ['PRIVATE_WARNING' as any], error: { code: 'COPY_REQUEST_FAILED', message: 'PRIVATE_SNAPSHOT_ERROR' } as any })
    const value = renderToStaticMarkup(f.root())
    for (const secret of ['PRIVATE_', base.sessionId]) expect(value).not.toContain(secret)
    expect(text(f.root())).toContain('status-copy operation did not complete')
  })
  it('localizes fixed failure codes and gives unknown values only a generic message', () => {
    const en = (_zh: string, value: string) => value, zh = (value: string) => value
    expect(statusCopyError('COPY_PLAYING_BLOCKED', en)).toContain('not forcibly taken over')
    expect(statusCopyError('COPY_SOURCE_NOT_PLAYING', en)).toContain('No source game is available')
    expect(statusCopyError('COPY_SOURCE_STALE', zh)).toContain('新鲜度未确认')
    expect(statusCopyError('PRIVATE_TOKEN', en)).not.toContain('PRIVATE_TOKEN')
  })
  it('renders Chinese labels and guidance through the shared language choice', async () => {
    hooks.language = 'zh'; const f = await fixture()
    expect(text(f.root())).toContain('保存设置（不启动）'); expect(text(f.root())).toContain('停止／取消')
    expect(text(f.root())).toContain('可能刷新 Steam 好友界面')
  })
})

describe('ASF mode privacy and capability limits', () => {
  const asfSettings: StatusCopySettings = { ...settings, mode: 'asf', asf: { url: 'http://127.0.0.1:1242', botName: 'TargetBot', hasPassword: true } }
  it('requires both source and target online bots and disables unsupported group size', async () => {
    const f = await fixture(); f.change('Copy group size', true); f.change('Status-copy interval', '5'); f.change('Status-copy mode', 'asf')
    expect(f.field('Copy group size').checked).toBe(false); expect(f.field('Copy group size').disabled).toBe(true)
    expect(f.field('Status-copy interval').min).toBe(15); expect(f.field('Status-copy interval').value).toBe('15')
    expect(text(f.root())).toContain('must both be signed-in, online ASF bots')
    expect(text(f.root())).toContain('not an arbitrary friend'); expect(text(f.root())).toContain('Bots are never started here')
    expect(text(f.root())).toContain('ASFStatusRelay 0.3 safe-edition')
    expect(text(f.root())).toContain('does not sign out or stop your pre-existing ASF bot')
    expect(text(f.root())).toContain('stop ASF bot ① yourself before switching back')
    f.change('ASF URL', asfSettings.asf!.url); f.change('ASF target bot', 'TargetBot')
    await f.click('Start following')
    expect(f.api.start.mock.calls[0]![0].settings.copyGroupSize).toBe(false)
    expect(f.api.start.mock.calls[0]![0].settings.asf).toEqual({ url: asfSettings.asf!.url, botName: 'TargetBot' })
  })
  it.each(['14', '121', '0.1', ''])('blocks invalid ASF intervals: %s', async value => {
    const f = await fixture({ initial: { ...base, settings: asfSettings } }); f.change('Status-copy interval', value)
    expect(f.button('Start following').disabled).toBe(true); await f.click('Start following'); expect(f.api.start).not.toHaveBeenCalled()
  })
  it.each(['file:///local', 'ftp://example.test', 'https://user:secret@example.test', 'https://example.test/#secret', 'not-a-url'])('blocks unsafe ASF URLs without echoing a parsed error: %s', async url => {
    const f = await fixture({ initial: { ...base, settings: asfSettings } }); f.change('ASF URL', url)
    expect(f.button('Connect and preview').disabled).toBe(true); await f.click('Connect and preview'); expect(f.api.preview).not.toHaveBeenCalled()
  })
  it('never backfills a password from a snapshot and clears submitted temporary password immediately', async () => {
    const f = await fixture({ initial: { ...base, settings: { ...asfSettings, asf: { ...asfSettings.asf!, password: 'PRIVATE_SNAPSHOT_PASSWORD' } as any } } })
    expect(f.field('ASF IPC password').value).toBe(''); expect(renderToStaticMarkup(f.root())).not.toContain('PRIVATE_SNAPSHOT_PASSWORD')
    f.change('ASF IPC password', 'TEMPORARY_TYPED_PASSWORD'); f.change('Allow replacing a stopped ASF configuration', true)
    await f.click('Save settings (do not start)')
    expect(f.api.save.mock.calls[0]![0]).toMatchObject({ allowAsfConfigReplace: true, settings: { asf: { password: 'TEMPORARY_TYPED_PASSWORD' } } })
    expect(f.field('ASF IPC password').value).toBe(''); expect(renderToStaticMarkup(f.root())).not.toContain('TEMPORARY_TYPED_PASSWORD')
    expect(f.api.start).not.toHaveBeenCalled()
  })
  it('leaves blank passwords undefined so saving retains the stored credential', async () => {
    const f = await fixture({ initial: { ...base, settings: asfSettings } }); await f.click('Save settings (do not start)')
    expect(f.api.save.mock.calls[0]![0].settings.asf).toEqual({ url: asfSettings.asf!.url, botName: 'TargetBot' })
  })
  it('marks password removal as draft-only and submits an explicit empty password only on Save', async () => {
    const f = await fixture({ initial: { ...base, settings: asfSettings } }); f.change('Clear the saved ASF password', true)
    expect(f.api.save).not.toHaveBeenCalled(); expect(f.api.preview).not.toHaveBeenCalled()
    expect(f.field('ASF IPC password').disabled).toBe(true); expect(f.button('Connect and preview').disabled).toBe(true)
    expect(f.button('Start following').disabled).toBe(true)
    await f.click('Connect and preview'); expect(f.api.preview).not.toHaveBeenCalled()
    await f.click('Start following'); expect(f.api.start).not.toHaveBeenCalled()
    await f.click('Save settings (do not start)')
    expect(f.api.save.mock.calls[0]![0].settings.asf).toEqual({ url: asfSettings.asf!.url, botName: 'TargetBot', password: '' })
    expect(f.field('Clear the saved ASF password').checked).toBe(false)
  })
  it('keeps password removal pending and reports Save failure even after an unchanged snapshot event', async () => {
    const f = await fixture({ initial: { ...base, settings: asfSettings } }), delayed = pending<StatusCopySnapshot>()
    f.api.save.mockReturnValueOnce(delayed.promise); f.change('Clear the saved ASF password', true)
    f.button('Save settings (do not start)').onClick(); await f.settle()
    expect(f.field('Clear the saved ASF password').checked).toBe(true)
    f.emit({ ...base, settings: asfSettings })
    delayed.reject({ code: 'COPY_REQUEST_FAILED', message: 'PRIVATE_DISK_FAILURE' }); await f.settle()
    expect(f.field('Clear the saved ASF password').checked).toBe(true)
    expect(f.button('Connect and preview').disabled).toBe(true); expect(f.button('Start following').disabled).toBe(true)
    expect(text(f.root())).toContain('status-copy operation did not complete'); expect(text(f.root())).not.toContain('PRIVATE_DISK_FAILURE')
    await f.click('Start following'); expect(f.api.start).not.toHaveBeenCalled()
    f.emit({ ...base, settings: asfSettings })
    expect(f.field('Clear the saved ASF password').checked).toBe(true)
    expect(text(f.root())).toContain('status-copy operation did not complete')
  })
  it('requires a saved hasPassword:false confirmation, not just a fulfilled Save promise', async () => {
    const f = await fixture({ initial: { ...base, settings: asfSettings } })
    f.api.save.mockResolvedValueOnce({ ...base, settings: asfSettings })
    f.change('Clear the saved ASF password', true); await f.click('Save settings (do not start)')
    expect(f.field('Clear the saved ASF password').checked).toBe(true)
    expect(f.button('Start following').disabled).toBe(true)
    expect(text(f.root())).toContain('status-copy operation did not complete')
  })
  it('confirms removal from the successful saved snapshot and then permits starting without the old credential', async () => {
    const f = await fixture({ initial: { ...base, settings: asfSettings } })
    f.change('Clear the saved ASF password', true); await f.click('Save settings (do not start)')
    expect(f.field('Clear the saved ASF password').checked).toBe(false)
    expect(f.button('Start following').disabled).toBe(false)
    await f.click('Start following')
    expect(f.api.save.mock.calls[0]![0].settings.asf?.password).toBe('')
    expect(f.api.start.mock.calls[0]![0].settings.asf).toEqual({ url: asfSettings.asf!.url, botName: 'TargetBot' })
  })
  it('confirms a matching saved false-password event and Save result without replacing the newer event', async () => {
    const f = await fixture({ initial: { ...base, settings: asfSettings } }), delayed = pending<StatusCopySnapshot>()
    f.api.save.mockReturnValueOnce(delayed.promise); f.change('Clear the saved ASF password', true)
    f.button('Save settings (do not start)').onClick(); await f.settle()
    f.emit({ ...base, settings: { ...asfSettings, asf: { ...asfSettings.asf!, hasPassword: false } } })
    expect(f.field('Clear the saved ASF password').checked).toBe(true)
    delayed.resolve({ ...base, settings: { ...asfSettings, asf: { ...asfSettings.asf!, hasPassword: false } } }); await f.settle()
    expect(f.field('Clear the saved ASF password').checked).toBe(false)
    expect(f.button('Start following').disabled).toBe(false)
    expect(text(f.root())).not.toContain('A password is saved')
  })
  it('does not clear the removal draft if a fulfilled Save result contradicts a false-password event', async () => {
    const f = await fixture({ initial: { ...base, settings: asfSettings } }), delayed = pending<StatusCopySnapshot>()
    f.api.save.mockReturnValueOnce(delayed.promise); f.change('Clear the saved ASF password', true)
    f.button('Save settings (do not start)').onClick(); await f.settle()
    f.emit({ ...base, settings: { ...asfSettings, asf: { ...asfSettings.asf!, hasPassword: false } } })
    delayed.resolve({ ...base, settings: asfSettings }); await f.settle()
    expect(f.field('Clear the saved ASF password').checked).toBe(true)
    expect(f.button('Start following').disabled).toBe(true)
    expect(text(f.root())).toContain('status-copy operation did not complete')
  })
  it('does not treat an older unchanged password event as successful removal', async () => {
    const f = await fixture({ initial: { ...base, settings: asfSettings } }), delayed = pending<StatusCopySnapshot>()
    f.api.save.mockReturnValueOnce(delayed.promise); f.change('Clear the saved ASF password', true)
    f.button('Save settings (do not start)').onClick(); await f.settle()
    f.emit({ ...base, settings: asfSettings })
    delayed.resolve({ ...base, settings: { ...asfSettings, asf: { ...asfSettings.asf!, hasPassword: false } } }); await f.settle()
    expect(f.field('Clear the saved ASF password').checked).toBe(true)
    expect(f.button('Start following').disabled).toBe(true)
  })
  it('does not clear a new session password-removal draft with an old session event or Save reply', async () => {
    const f = await fixture({ initial: { ...base, settings: asfSettings } }), delayed = pending<StatusCopySnapshot>()
    f.api.save.mockReturnValueOnce(delayed.promise); f.change('Clear the saved ASF password', true)
    f.button('Save settings (do not start)').onClick(); await f.settle()
    f.emit({ ...base, sessionId: 'new-password-session', settings: asfSettings })
    f.change('Clear the saved ASF password', true)
    f.emit({ ...base, settings: { ...asfSettings, asf: { ...asfSettings.asf!, hasPassword: false } } })
    delayed.resolve({ ...base, settings: { ...asfSettings, asf: { ...asfSettings.asf!, hasPassword: false } } }); await f.settle()
    expect(f.field('Clear the saved ASF password').checked).toBe(true)
    expect(f.button('Start following').disabled).toBe(true)
  })
  it('clears transient secrets when the source, mode, endpoint or target bot changes', async () => {
    const f = await fixture({ initial: { ...base, settings: asfSettings } })
    for (const [name, value] of [['Source Steam64ID', '76561198000000003'], ['ASF URL', 'http://127.0.0.1:1243'], ['ASF target bot', 'OtherBot']]) {
      f.change('ASF IPC password', 'TEMP_SECRET'); f.change(name!, value!)
      expect(f.field('ASF IPC password').value).toBe('')
    }
    f.change('Clear the saved ASF password', true); f.change('Status-copy mode', 'toolbox'); f.change('Status-copy mode', 'asf')
    expect(f.field('Clear the saved ASF password').checked).toBe(false)
  })
  it('does not let stale password or replacement handlers edit an in-flight request', async () => {
    const f = await fixture({ initial: { ...base, settings: asfSettings } }), delayed = pending<StatusCopySnapshot>()
    const oldPassword = f.field('ASF IPC password'), oldRemoval = f.field('Clear the saved ASF password'), oldReplace = f.field('Allow replacing a stopped ASF configuration')
    f.api.save.mockReturnValueOnce(delayed.promise); f.button('Save settings (do not start)').onClick()
    oldPassword.onChange({ target: { value: 'STALE_PASSWORD' } }); oldRemoval.onChange({ target: { checked: true } }); oldReplace.onChange({ target: { checked: true } })
    await f.settle()
    expect(f.field('ASF IPC password').value).toBe(''); expect(f.field('Clear the saved ASF password').checked).toBe(false)
    expect(f.field('Allow replacing a stopped ASF configuration').checked).toBe(false)
    delayed.resolve({ ...base, settings: asfSettings }); await f.settle()
  })
  it('does not offer replacement or Start while a task is running, but Stop remains available', async () => {
    const f = await fixture({ initial: { ...base, phase: 'following', settings: asfSettings } })
    expect(f.field('Allow replacing a stopped ASF configuration').disabled).toBe(true)
    expect(f.button('Start following').disabled).toBe(true)
    await f.click('Start following'); expect(f.api.start).not.toHaveBeenCalled()
    expect(f.button('Stop / cancel').disabled).toBe(false)
  })
  it('never calls a submission timestamp an independently verified ASF status', async () => {
    const f = await fixture({ initial: { ...base, settings: asfSettings, source: { ...source, authority: 'asf-source-session' }, targetAppId: 438100,
      appliedAt: '2026-10-22T03:00:01Z', verification: 'target-readback' } })
    expect(text(f.root())).toContain('ASF records plugin submission only, without independent readback or friend-client confirmation')
    expect(text(f.root())).not.toContain('Read back from the target session, not confirmed by a friend client')
  })
  it('does not claim an ASF stop succeeded when stopping is unconfirmed', async () => {
    const f = await fixture({ initial: { ...base, phase: 'following', settings: asfSettings } })
    f.api.stop.mockRejectedValueOnce({ code: 'COPY_STOP_UNCONFIRMED', message: 'PRIVATE_NETWORK_SECRET' })
    await f.click('Stop / cancel')
    const value = text(f.root())
    expect(value).toContain('Stop unconfirmed'); expect(value).toContain('task may still be running')
    expect(value).not.toContain('Not running'); expect(value).not.toContain('PRIVATE_NETWORK_SECRET')
    expect(f.button('Stop / cancel').disabled).toBe(false)
  })
})
