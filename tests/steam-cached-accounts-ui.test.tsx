import type { ReactElement, ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SteamCachedAccountsApi, SteamCachedAccountsSnapshot } from '../src/shared/steam-cached-accounts'

const hooks = vi.hoisted(() => ({ cursor: 0, slots: [] as any[], effects: [] as Array<() => void>, language: 'en' as 'zh-CN' | 'en' }))
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
import { SteamCachedAccountsPanel, SteamCachedAccountAvatar, staticCachedAvatarDataUrl, steamCachedAccountsError } from '../src/renderer/src/components/SteamCachedAccountsPanel'

const base: SteamCachedAccountsSnapshot = {
  revision: 'cache-revision-A', steamPath: 'C:\\Steam-private-fixture', steamRunning: true, busy: false, status: 'idle', error: null,
  accounts: [
    { steamId: '76561198000000001', accountName: 'small-blue', displayName: 'Blue account', remembered: true, mostRecent: true, lastLoginAt: '2026-11-10T01:00:00.000Z' },
    { steamId: '76561198000000002', accountName: 'small-second', displayName: 'Second account', remembered: false, mostRecent: false, lastLoginAt: null }
  ]
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
  vi.useRealTimers(); vi.unstubAllGlobals()
})

async function fixture(options: { initial?: SteamCachedAccountsSnapshot; visible?: boolean; language?: 'zh-CN' | 'en'; initialPromise?: Promise<SteamCachedAccountsSnapshot> } = {}) {
  hooks.language = options.language ?? 'en'
  const api = {
    state: vi.fn(async () => options.initial ?? base),
    switchAccount: vi.fn(async (): Promise<SteamCachedAccountsSnapshot> => ({ ...base, status: 'awaiting-login' })),
    action: vi.fn(async (): Promise<{ performed: boolean; state: SteamCachedAccountsSnapshot }> => ({ performed: true, state: base })),
    restoreHidden: vi.fn(async (): Promise<SteamCachedAccountsSnapshot> => base)
  } satisfies SteamCachedAccountsApi
  if (options.initialPromise) api.state.mockReturnValueOnce(options.initialPromise)
  const props: { api: SteamCachedAccountsApi; visible: boolean } = { api, visible: options.visible ?? true }
  let root: ReactElement<any>
  const render = () => { hooks.cursor = 0; root = SteamCachedAccountsPanel(props); hooks.effects.splice(0).forEach(effect => effect()); return root }
  const settle = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); render() }
  const button = (label: string) => {
    const found = nodes(root).find(node => node.type === 'button' && (text(node.props.children) === label || node.props['aria-label'] === label))
    if (!found) throw new Error(`Missing ${label}`)
    return found.props
  }
  const click = async (label: string) => { button(label).onClick(); await settle() }
  render(); await settle()
  return { api, props, render, settle, button, click, root: () => root }
}

describe('Steam cached account panel', () => {
  it.each(['zh-CN', 'en'] as const)('reads only the local list on entry and explains the account boundary in %s', async language => {
    const f = await fixture({ language })
    expect(f.api.state).toHaveBeenCalledOnce()
    expect(f.api.switchAccount).not.toHaveBeenCalled()
    const content = text(f.root())
    expect(content).toContain(language === 'en' ? 'Local cache, not toolbox accounts' : '本机缓存，不是工具箱账号')
    expect(content).toContain(language === 'en' ? 'Steam must exit normally before switching' : '切换前需要正常退出 Steam')
    expect(content).toContain(language === 'en' ? 'verification when the login cache is missing or expired' : '登录缓存缺失或失效时')
    expect(content).not.toContain(base.steamPath)
    expect(nodes(f.root()).filter(node => node.type === 'input')).toHaveLength(0)
  })

  it('shows remembered and recent markers without claiming they prove current sign-in', async () => {
    const f = await fixture()
    expect(text(f.root())).toContain('Account remembered')
    expect(text(f.root())).toContain('Most recently used')
    expect(text(f.root())).toContain('Verification may be needed')
    expect(text(f.root())).not.toContain('Signed in successfully')
  })

  it('renders selectable account cards with scoped long-name and SteamID wrapping', async () => {
    const f = await fixture()
    expect(f.root().props.className).toContain('steam-cached-accounts-panel')
    expect(nodes(f.root()).filter(node => node.type === 'article' && node.props.className.includes('steam-account-card'))).toHaveLength(2)
    expect(nodes(f.root()).filter(node => node.type === 'span' && node.props.className === 'steam-account-name')).toHaveLength(2)
    expect(nodes(f.root()).filter(node => node.type === 'code' && text(node.props.children).startsWith('7656119'))
      .every(node => node.props.className === 'steam-account-id')).toBe(true)
  })

  it('sends only the explicitly selected SteamID and current list revision to the native switch', async () => {
    const f = await fixture()
    await f.click('Switch Steam to small-second')
    expect(f.api.switchAccount).toHaveBeenCalledExactlyOnceWith({ steamId: base.accounts[1]!.steamId, revision: base.revision })
    expect(text(f.root())).toContain('This does not confirm a successful sign-in')
    expect(f.api.state).toHaveBeenCalledOnce()
  })

  it('refreshes the list without initiating a switch and uses its new revision later', async () => {
    const f = await fixture()
    f.api.state.mockResolvedValueOnce({ ...base, revision: 'cache-revision-B' })
    await f.click('Refresh list')
    expect(f.api.switchAccount).not.toHaveBeenCalled()
    await f.click('Switch Steam to small-blue')
    expect(f.api.switchAccount).toHaveBeenLastCalledWith({ steamId: base.accounts[0]!.steamId, revision: 'cache-revision-B' })
  })

  it('blocks duplicate clicks while native confirmation or switching is pending', async () => {
    const f = await fixture()
    const native = deferred<SteamCachedAccountsSnapshot>()
    f.api.switchAccount.mockReturnValueOnce(native.promise)
    const click = f.button('Switch Steam to small-second').onClick
    click(); click(); await f.settle()
    expect(f.api.switchAccount).toHaveBeenCalledOnce()
    expect(f.button('Switch Steam to small-blue').disabled).toBe(true)
    native.resolve({ ...base, status: 'cancelled' }); await f.settle()
    expect(text(f.root())).toContain('This switch was cancelled')
  })

  it('keeps a read-only refresh possible when a previous view observed a busy backend', async () => {
    const f = await fixture({ initial: { ...base, busy: true, status: 'switching' } })
    expect(f.button('Switch Steam to small-blue').disabled).toBe(true)
    expect(f.button('Refresh list').disabled).toBe(false)
    f.api.state.mockResolvedValueOnce(base)
    await f.click('Refresh list')
    expect(f.button('Switch Steam to small-blue').disabled).toBe(false)
  })

  it('does not initiate switch actions before the initial list is available', async () => {
    const pending = deferred<SteamCachedAccountsSnapshot>()
    const f = await fixture({ initialPromise: pending.promise })
    expect(nodes(f.root()).some(node => node.props['aria-label'] === 'Switch Steam to small-blue')).toBe(false)
    pending.resolve(base); await f.settle()
    expect(f.button('Switch Steam to small-blue').disabled).toBe(false)
  })

  it('does not fetch while its page is hidden and discards a late initial result', async () => {
    const pending = deferred<SteamCachedAccountsSnapshot>()
    const f = await fixture({ visible: false, initialPromise: pending.promise })
    expect(f.api.state).not.toHaveBeenCalled()
    f.props.visible = true; f.render(); await f.settle()
    expect(f.api.state).toHaveBeenCalledOnce()
    f.props.visible = false; f.render(); await f.settle()
    pending.resolve(base); await f.settle()
    expect(text(f.root())).not.toContain('Blue account')
    expect(f.root().props.hidden).toBe(true)
  })

  it('ignores late switch results after leaving and reopening the page', async () => {
    const f = await fixture()
    const pending = deferred<SteamCachedAccountsSnapshot>()
    f.api.switchAccount.mockReturnValueOnce(pending.promise)
    await f.click('Switch Steam to small-second')
    f.props.visible = false; f.render(); await f.settle()
    f.props.visible = true; f.render(); await f.settle()
    pending.resolve({ ...base, status: 'awaiting-login' }); await f.settle()
    expect(text(f.root())).not.toContain('This does not confirm a successful sign-in')
  })

  it('maps stable errors without printing arbitrary failed messages or credentials', async () => {
    const f = await fixture()
    f.api.switchAccount.mockRejectedValueOnce({ code: 'STEAM_CACHE_GAME_RUNNING', message: 'password=private-secret-fixture' })
    await f.click('Switch Steam to small-blue')
    expect(text(f.root())).toContain('Exit running Steam games normally')
    expect(text(f.root())).not.toContain('private-secret-fixture')
    expect(text(f.root())).not.toContain('STEAM_CACHE_GAME_RUNNING')
  })

  it('shows the empty state without offering to acquire passwords or scan unrelated folders', async () => {
    const f = await fixture({ initial: { ...base, accounts: [] } })
    expect(text(f.root())).toContain('No cached client accounts found')
    expect(text(f.root())).toContain('No other directories or passwords are scanned')
    expect(nodes(f.root()).filter(node => node.type === 'button')).toHaveLength(1)
  })

  it('selects a card without switching Steam and opens a more-actions menu explicitly', async () => {
    const f = await fixture()
    await f.click('Select account small-second')
    expect(f.api.switchAccount).not.toHaveBeenCalled()
    expect(f.api.action).not.toHaveBeenCalled()
    expect(f.button('Select account small-second')['aria-pressed']).toBe(true)
    f.button('More actions for small-second').onClick({ currentTarget: { getBoundingClientRect: () => ({ right: 600, bottom: 400 }) } })
    await f.settle()
    expect(nodes(f.root()).some(node => node.props.role === 'menu')).toBe(true)
    expect(text(f.root())).toContain('Hide from toolbox')
    expect(text(f.root())).not.toContain('Delete Steam account')
  })

  it('uses the same guarded menu for right-click without launching an account', async () => {
    const f = await fixture()
    const event = { preventDefault: vi.fn(), clientX: 500, clientY: 300 }
    nodes(f.root()).find(node => node.type === 'article')!.props.onContextMenu(event)
    await f.settle()
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(nodes(f.root()).some(node => node.props.role === 'menu')).toBe(true)
    expect(f.api.switchAccount).not.toHaveBeenCalled()
  })

  it('sends only selected ID, revision and the chosen safe copy action', async () => {
    const f = await fixture()
    f.button('More actions for small-second').onClick({ currentTarget: { getBoundingClientRect: () => ({ right: 600, bottom: 400 }) } }); await f.settle()
    await f.click('Copy SteamID')
    expect(f.api.action).toHaveBeenCalledExactlyOnceWith({ steamId: base.accounts[1]!.steamId, revision: base.revision, action: 'copy-id' })
    expect(text(f.root())).toContain('Selected account information copied')
  })

  it('routes offline launch through the existing native switch confirmation', async () => {
    const f = await fixture()
    f.button('More actions for small-second').onClick({ currentTarget: { getBoundingClientRect: () => ({ right: 600, bottom: 400 }) } }); await f.settle()
    await f.click('Start in offline mode')
    expect(f.api.switchAccount).toHaveBeenCalledExactlyOnceWith({ steamId: base.accounts[1]!.steamId, revision: base.revision, mode: 'offline' })
    expect(f.api.action).not.toHaveBeenCalled()
  })

  it('opens a non-blocking local-note editor without calling prompt or changing Steam names', async () => {
    const prompt = vi.fn()
    vi.stubGlobal('prompt', prompt)
    const f = await fixture()
    f.button('More actions for small-second').onClick({ currentTarget: { getBoundingClientRect: () => ({ right: 600, bottom: 400 }) } }); await f.settle()
    await f.click('Edit local note')
    expect(nodes(f.root()).some(node => node.props.role === 'dialog')).toBe(true)
    expect(text(f.root())).toContain('the Steam display name is unchanged')
    nodes(f.root()).find(node => node.type === 'textarea')!.props.onChange({ target: { value: 'Synthetic local note' } }); await f.settle()
    await f.click('Save note')
    expect(f.api.action).toHaveBeenCalledWith({ steamId: base.accounts[1]!.steamId, revision: base.revision, action: 'note', note: 'Synthetic local note' })
    expect(prompt).not.toHaveBeenCalled()
  })

  it('labels hiding as a toolbox-list action and does not claim that Steam credentials or userdata were deleted', async () => {
    const f = await fixture()
    f.button('More actions for small-second').onClick({ currentTarget: { getBoundingClientRect: () => ({ right: 600, bottom: 400 }) } }); await f.settle()
    await f.click('Hide from toolbox')
    expect(f.api.action).toHaveBeenCalledWith({ steamId: base.accounts[1]!.steamId, revision: base.revision, action: 'hide' })
    expect(text(f.root())).toContain('Steam login cache and userdata were not deleted')
  })

  it('does not report a native-cancelled action as completed', async () => {
    const f = await fixture()
    f.api.action.mockResolvedValueOnce({ performed: false, state: base })
    f.button('More actions for small-second').onClick({ currentTarget: { getBoundingClientRect: () => ({ right: 600, bottom: 400 }) } }); await f.settle()
    await f.click('Create switch shortcut')
    expect(text(f.root())).not.toContain('Shortcut created')
  })

  it('restores the toolbox hidden list only on an explicit click', async () => {
    const f = await fixture({ initial: { ...base, hiddenCount: 2 } })
    expect(f.api.restoreHidden).not.toHaveBeenCalled()
    await f.click('Show hidden accounts (2)')
    expect(f.api.restoreHidden).toHaveBeenCalledOnce()
  })

  it.each(['STEAM_CACHE_UNAVAILABLE', 'STEAM_CACHE_INVALID', 'STEAM_CACHE_CHANGED', 'STEAM_CACHE_BUSY',
    'STEAM_CACHE_GAME_RUNNING', 'STEAM_CACHE_EXIT_UNCONFIRMED', 'STEAM_CACHE_LAUNCH_FAILED',
    'STEAM_CACHE_WRITE_FAILED', 'STEAM_CACHE_CLIENT_CHANGED', 'STEAM_CACHE_RECOVERY_REQUIRED',
    'STEAM_CACHE_ACTIVITY_UNAVAILABLE', 'secret-fixture-unknown'])('translates error %s without exposing the raw identifier', code => {
    const en = steamCachedAccountsError(code, (_zh, english) => english)
    const zh = steamCachedAccountsError(code, chinese => chinese)
    expect(en).not.toMatch(/\p{Script=Han}/u)
    expect(en).not.toContain(code)
    expect(zh).not.toContain(code)
    expect(en.endsWith('.')).toBe(false)
    expect(zh.endsWith('。')).toBe(false)
  })

  it('requires manual recovery instead of suggesting refresh resolves incomplete switch restoration', () => {
    const message = steamCachedAccountsError('STEAM_CACHE_RECOVERY_REQUIRED', (_zh, english) => english)
    expect(message).toContain('further switching has stopped')
    expect(message).toContain('Keep the recovery record')
    expect(message.toLowerCase()).not.toContain('refresh')
  })

  it('does not claim Steam exited when game activity could not be verified', () => {
    const message = steamCachedAccountsError('STEAM_CACHE_ACTIVITY_UNAVAILABLE', (_zh, english) => english)
    expect(message).toContain('Steam was not exited automatically')
    expect(message).toContain('check manually first')
  })
})

describe('static local cache avatars', () => {
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jA5sAAAAASUVORK5CYII='
  it('accepts a small static data URL but never a remote image, GIF, SVG, frame or animation URL', () => {
    expect(staticCachedAvatarDataUrl(png)).toBe(png)
    for (const value of ['https://avatars.steamstatic.com/avatar.jpg', 'file:///C:/private/avatar.png',
      'data:image/gif;base64,R0lGODlh', 'data:image/svg+xml,<svg/>', 'https://cdn.example/frame.webm']) {
      expect(staticCachedAvatarDataUrl(value)).toBeNull()
    }
  })

  it('requests an avatar only after its own card enters the viewport and never retries in the background', async () => {
    let callback!: IntersectionObserverCallback
    const disconnect = vi.fn(), observe = vi.fn()
    vi.stubGlobal('IntersectionObserver', class { constructor(value: IntersectionObserverCallback) { callback = value } disconnect = disconnect; observe = observe })
    const avatar = vi.fn(async () => png)
    const api: SteamCachedAccountsApi = { state: async () => base, switchAccount: async () => base, avatar }
    const props = { api, steamId: base.accounts[0]!.steamId, revision: base.revision, name: 'Synthetic', active: true }
    let root: ReactElement<any>
    const render = () => {
      hooks.cursor = 0; root = SteamCachedAccountAvatar(props)
      root.props.ref.current = {}
      hooks.effects.splice(0).forEach(effect => effect())
    }
    render()
    expect(avatar).not.toHaveBeenCalled()
    callback([{ isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver)
    expect(avatar).not.toHaveBeenCalled()
    callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver)
    for (let index = 0; index < 10; index++) await Promise.resolve()
    render()
    expect(avatar).toHaveBeenCalledExactlyOnceWith({ steamId: props.steamId, revision: base.revision })
    expect(nodes(root!).find(node => node.type === 'img')!.props.src).toBe(png)
    callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver)
    expect(avatar).toHaveBeenCalledOnce()
    props.active = false; render()
    expect(disconnect).toHaveBeenCalled()
  })

  it('does not create a lazy-load observer when the page is inactive', () => {
    const observer = vi.fn()
    vi.stubGlobal('IntersectionObserver', observer)
    const avatar = vi.fn(async () => png)
    const api: SteamCachedAccountsApi = { state: async () => base, switchAccount: async () => base, avatar }
    hooks.cursor = 0
    const root = SteamCachedAccountAvatar({ api, steamId: base.accounts[0]!.steamId, revision: base.revision, name: 'Synthetic', active: false })
    ;(root.props as any).ref.current = {}
    hooks.effects.splice(0).forEach(effect => effect())
    expect(observer).not.toHaveBeenCalled()
    expect(avatar).not.toHaveBeenCalled()
  })
})
