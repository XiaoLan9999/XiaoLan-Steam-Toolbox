import type { ReactElement, ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SteamAuthenticatorConfirmationEntry } from '../src/renderer/src/components/SteamAuthenticatorConfirmationsPanel'
import type { SteamAuthenticatorConfirmationRespondInput, SteamAuthenticatorConfirmationResult, SteamAuthenticatorConfirmationSnapshot, SteamAuthenticatorConfirmationsApi } from '../src/shared/steam-authenticator-confirmations'

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
vi.mock('../src/renderer/src/energy-saving', () => ({ isEnergySavingActive: () => energy.active,
  subscribeEnergySaving: (listener: (value: boolean) => void) => { energy.listeners.add(listener); return () => energy.listeners.delete(listener) } }))
import { SteamAuthenticatorConfirmationsPanel, steamAuthenticatorConfirmationError, steamAuthenticatorConfirmationResultText } from '../src/renderer/src/components/SteamAuthenticatorConfirmationsPanel'

const NOW = Date.UTC(2026, 10, 10, 0, 0, 0)
const STEAM_A = '76561198000000001'
const STEAM_B = '76561198000000002'
const entries: SteamAuthenticatorConfirmationEntry[] = [
  { id: 'entry-A', name: 'Guard A', steamId: STEAM_A, capabilities: { hasConfirmations: true, fullBackup: false } },
  { id: 'entry-B', name: 'Guard B', steamId: STEAM_B, capabilities: { hasConfirmations: true, fullBackup: true } },
  { id: 'entry-legacy', name: 'Legacy codes', steamId: null, capabilities: { hasConfirmations: false, fullBackup: false } }
]
const base: SteamAuthenticatorConfirmationSnapshot = { entryId: 'entry-A', ownerSteamId: STEAM_A, listId: 'list-A', listedAt: NOW, expiresAt: NOW + 60_000,
  items: [
    { id: 'trade-A', type: 2, title: 'Trade with synthetic partner', summary: ['Item A for item B', 'Review the partner in Steam'], canRespond: true },
    { id: 'market-A', type: 3, title: 'Synthetic market listing', summary: ['Synthetic item listing'], canRespond: true },
    { id: 'other-A', type: 99, title: 'Unrecognized confirmation', summary: ['Unsupported response type'], canRespond: false }
  ] }
const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (value: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const nodes = (value: ReactNode): ReactElement<any>[] => !value || typeof value !== 'object' ? [] : Array.isArray(value)
  ? value.flatMap(nodes) : [value as ReactElement<any>, ...nodes((value as ReactElement<any>).props.children)]
const text = (value: ReactNode): string => typeof value === 'string' || typeof value === 'number' ? String(value)
  : Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text((value as ReactElement<any>).props.children) : ''

afterEach(() => {
  for (const entry of hooks.slots) entry?.cleanup?.()
  hooks.cursor = 0; hooks.slots = []; hooks.effects = []; hooks.language = 'en'
  energy.active = false; energy.listeners.clear(); vi.useRealTimers(); vi.unstubAllGlobals()
})

async function fixture(options: { language?: 'zh-CN' | 'en'; selectedSteamId?: string | null; visible?: boolean; entries?: SteamAuthenticatorConfirmationEntry[]; noApi?: boolean } = {}) {
  vi.useFakeTimers(); vi.setSystemTime(NOW)
  const page = Object.assign(new EventTarget(), { visibilityState: 'visible' })
  vi.stubGlobal('document', page)
  hooks.language = options.language ?? 'en'
  const api = {
    list: vi.fn(async (): Promise<SteamAuthenticatorConfirmationSnapshot> => base),
    respond: vi.fn(async (input: SteamAuthenticatorConfirmationRespondInput): Promise<SteamAuthenticatorConfirmationResult> => ({ ...input, outcome: 'accepted', requestSubmitted: true }))
  } satisfies SteamAuthenticatorConfirmationsApi
  const props: React.ComponentProps<typeof SteamAuthenticatorConfirmationsPanel> = {
    api: options.noApi ? undefined : api, entries: options.entries ?? entries, selectedSteamId: options.selectedSteamId === undefined ? STEAM_A : options.selectedSteamId, visible: options.visible ?? true
  }
  let root: ReactElement<any>
  const render = () => { hooks.cursor = 0; root = SteamAuthenticatorConfirmationsPanel(props); hooks.effects.splice(0).forEach(effect => effect()); return root }
  const settle = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); render() }
  const button = (label: string) => {
    const found = nodes(root).find(node => node.type === 'button' && (text(node.props.children) === label || node.props['aria-label'] === label))
    if (!found) throw new Error(`Missing ${label}`)
    return found.props
  }
  const click = async (label: string) => { button(label).onClick(); await settle() }
  const select = async (id: string) => { nodes(root).find(node => node.type === 'select')!.props.onChange({ target: { value: id } }); await settle() }
  const advance = async (milliseconds: number) => { await vi.advanceTimersByTimeAsync(milliseconds); await settle() }
  render(); await settle()
  return { api, props, root: () => root, render, settle, button, click, select, advance,
    async hideDocument() { page.visibilityState = 'hidden'; page.dispatchEvent(new Event('visibilitychange')); await settle() },
    async energySaving(active: boolean) { energy.active = active; for (const listener of energy.listeners) listener(active); await settle() }
  }
}

describe('manual trade and market confirmations', () => {
  it.each(['zh-CN', 'en'] as const)('does not query or act on entry and explains its session boundary in %s', async language => {
    const f = await fixture({ language })
    expect(f.api.list).not.toHaveBeenCalled(); expect(f.api.respond).not.toHaveBeenCalled()
    expect(text(f.root())).toContain(language === 'en' ? 'matching account in the toolbox sidebar' : '在左侧工具箱账号中选择并登录与令牌相同的账号')
    expect(text(f.root())).toContain(language === 'en' ? 'no automatic or bulk approvals' : '不会自动允许或批量确认')
    expect(nodes(f.root()).some(node => node.type === 'input')).toBe(false)
  })

  it('renders no fake response controls when the main confirmation interface is absent', async () => {
    const f = await fixture({ noApi: true })
    expect(text(f.root())).toContain('The confirmation interface is not connected')
    expect(nodes(f.root()).filter(node => node.type === 'button')).toHaveLength(0)
  })

  it.each([null, STEAM_B])('does not request confirmations for an unmatched selected account %s', async selectedSteamId => {
    const f = await fixture({ selectedSteamId })
    expect(f.button('Load confirmations manually').disabled).toBe(true)
    await f.click('Load confirmations manually')
    expect(f.api.list).not.toHaveBeenCalled()
  })

  it('makes legacy codes-only records unselectable for confirmation processing', async () => {
    const f = await fixture({ entries: [entries[2]!] })
    expect(f.button('Load confirmations manually').disabled).toBe(true)
    expect(text(f.root())).toContain('re-import the original maFile')
    expect(nodes(f.root()).find(node => node.type === 'option' && node.props.value === 'entry-legacy')!.props.disabled).toBe(true)
  })

  it('loads only after explicit action and exposes only individual trade/market decisions', async () => {
    const f = await fixture()
    await f.click('Load confirmations manually')
    expect(f.api.list).toHaveBeenCalledExactlyOnceWith({ entryId: 'entry-A' })
    expect(text(f.root())).toContain('Trade with synthetic partner')
    expect(text(f.root())).toContain('Unsupported type')
    expect(nodes(f.root()).filter(node => node.type === 'button' && node.props['aria-label']?.startsWith('Allow confirmation'))).toHaveLength(2)
    expect(nodes(f.root()).some(node => node.type === 'button' && /\ball\b/i.test(text(node.props.children)))).toBe(false)
    expect(nodes(f.root()).some(node => node.type === 'input' && node.props.type === 'checkbox')).toBe(false)
  })

  it('sends one exact immutable confirmation context and clears the consumed lease', async () => {
    const f = await fixture()
    await f.click('Load confirmations manually')
    await f.click('Allow confirmation Trade with synthetic partner')
    expect(f.api.respond).toHaveBeenCalledExactlyOnceWith({ entryId: 'entry-A', listId: 'list-A', confirmationId: 'trade-A', action: 'allow' })
    expect(text(f.root())).toContain('This does not mean a trade completed')
    expect(text(f.root())).not.toContain('Trade with synthetic partner')
    expect(f.api.list).toHaveBeenCalledOnce()
  })

  it('sends cancellation as an explicit per-item operation without claiming a rejected API request rejected the trade', async () => {
    const f = await fixture()
    await f.click('Load confirmations manually')
    await f.click('Cancel confirmation Synthetic market listing')
    expect(f.api.respond).toHaveBeenCalledWith({ entryId: 'entry-A', listId: 'list-A', confirmationId: 'market-A', action: 'cancel' })
    expect(text(f.root())).toContain('endpoint accepted the cancel request')
  })

  it.each(['unknown', 'rejected', 'cancelled', 'stale'] as const)('does not automatically refresh or retry outcome %s', async outcome => {
    const f = await fixture()
    f.api.respond.mockImplementationOnce(async input => ({ ...input, outcome, requestSubmitted: outcome === 'unknown' || outcome === 'rejected' }))
    await f.click('Load confirmations manually')
    await f.click('Allow confirmation Trade with synthetic partner')
    await f.advance(120_000)
    expect(f.api.respond).toHaveBeenCalledOnce()
    expect(f.api.list).toHaveBeenCalledOnce()
    expect(text(f.root())).not.toContain('Trade with synthetic partner')
    expect(text(f.root())).not.toContain('Trade completed')
  })

  it('disables expired decisions without automatically reloading a new list', async () => {
    const f = await fixture()
    await f.click('Load confirmations manually')
    await f.advance(60_000)
    expect(f.button('Allow confirmation Trade with synthetic partner').disabled).toBe(true)
    await f.click('Allow confirmation Trade with synthetic partner')
    expect(f.api.respond).not.toHaveBeenCalled()
    expect(f.api.list).toHaveBeenCalledOnce()
  })

  it('rejects a list from an unexpected owner before rendering its items', async () => {
    const f = await fixture()
    f.api.list.mockResolvedValueOnce({ ...base, ownerSteamId: STEAM_B })
    await f.click('Load confirmations manually')
    expect(text(f.root())).not.toContain('Trade with synthetic partner')
    expect(text(f.root())).toContain('does not match the authenticator SteamID')
  })

  it('does not accept a canRespond hint for an unsupported confirmation type', async () => {
    const f = await fixture()
    f.api.list.mockResolvedValueOnce({ ...base, items: [{ ...base.items[2]!, canRespond: true }] })
    await f.click('Load confirmations manually')
    expect(text(f.root())).toContain('This item is read-only')
    expect(nodes(f.root()).some(node => node.type === 'button' && node.props['aria-label']?.startsWith('Allow confirmation'))).toBe(false)
  })

  it('explains an already-submitted confirmation cannot be resent merely by reloading or restarting', async () => {
    const f = await fixture()
    f.api.list.mockResolvedValueOnce({ ...base, items: [{ ...base.items[0]!, canRespond: false, blockedReason: 'already-submitted' }] })
    await f.click('Load confirmations manually')
    expect(text(f.root())).toContain('has a submission record and cannot be sent again')
    expect(text(f.root())).toContain('reloading or restarting does not make another attempt safe')
    expect(nodes(f.root()).some(node => node.type === 'button' && node.props['aria-label']?.startsWith('Allow confirmation'))).toBe(false)
  })

  it('prevents duplicate responses while a native confirmation or request is pending', async () => {
    const f = await fixture()
    await f.click('Load confirmations manually')
    const pending = deferred<SteamAuthenticatorConfirmationResult>()
    f.api.respond.mockReturnValueOnce(pending.promise)
    const click = f.button('Allow confirmation Trade with synthetic partner').onClick
    click(); click(); await f.settle()
    expect(f.api.respond).toHaveBeenCalledOnce()
    expect(f.button('Cancel confirmation Synthetic market listing').disabled).toBe(true)
    pending.resolve({ entryId: 'entry-A', listId: 'list-A', confirmationId: 'trade-A', action: 'allow', outcome: 'cancelled', requestSubmitted: false }); await f.settle()
    expect(text(f.root())).toContain('no confirmation request was submitted')
  })

  it('discards a delayed lookup after the selected toolbox account changes', async () => {
    const f = await fixture()
    const pending = deferred<SteamAuthenticatorConfirmationSnapshot>()
    f.api.list.mockReturnValueOnce(pending.promise)
    await f.click('Load confirmations manually')
    f.props.selectedSteamId = STEAM_B; f.render(); await f.settle()
    pending.resolve(base); await f.settle()
    expect(text(f.root())).not.toContain('Trade with synthetic partner')
    expect(f.button('Load confirmations manually').disabled).toBe(true)
  })

  it('clears loaded confirmations when the authenticator selection changes', async () => {
    const f = await fixture()
    await f.click('Load confirmations manually')
    await f.select('entry-B')
    expect(text(f.root())).not.toContain('Trade with synthetic partner')
    expect(f.api.list).toHaveBeenCalledOnce()
  })

  it('discards a delayed mutation response after hiding and never automatically replays it on return', async () => {
    const f = await fixture()
    await f.click('Load confirmations manually')
    const pending = deferred<SteamAuthenticatorConfirmationResult>()
    f.api.respond.mockReturnValueOnce(pending.promise)
    await f.click('Allow confirmation Trade with synthetic partner')
    f.props.visible = false; f.render(); await f.settle()
    f.props.visible = true; f.render(); await f.settle()
    pending.resolve({ entryId: 'entry-A', listId: 'list-A', confirmationId: 'trade-A', action: 'allow', outcome: 'accepted', requestSubmitted: true }); await f.settle()
    expect(text(f.root())).not.toContain('endpoint accepted the allow request')
    expect(f.api.list).toHaveBeenCalledOnce(); expect(f.api.respond).toHaveBeenCalledOnce()
  })

  it('clears items and the expiry timer when the document is hidden', async () => {
    const f = await fixture()
    await f.click('Load confirmations manually')
    await f.hideDocument()
    expect(text(f.root())).not.toContain('Trade with synthetic partner')
    expect(vi.getTimerCount()).toBe(0)
    await f.advance(120_000)
    expect(f.api.list).toHaveBeenCalledOnce()
  })

  it('pauses lease timing without invalidating confirmation context on focus-only energy saving', async () => {
    const f = await fixture()
    await f.click('Load confirmations manually')
    await f.energySaving(true)
    expect(text(f.root())).toContain('Trade with synthetic partner')
    expect(vi.getTimerCount()).toBe(0)
    expect(f.button('Allow confirmation Trade with synthetic partner').disabled).toBe(true)
    await f.energySaving(false)
    expect(f.button('Allow confirmation Trade with synthetic partner').disabled).toBe(false)
    expect(f.api.list).toHaveBeenCalledOnce()
  })

  it('preserves a native-dialog response across focus-only blur and focus without resubmitting', async () => {
    const f = await fixture()
    await f.click('Load confirmations manually')
    const pending = deferred<SteamAuthenticatorConfirmationResult>()
    f.api.respond.mockReturnValueOnce(pending.promise)
    await f.click('Allow confirmation Trade with synthetic partner')
    await f.energySaving(true)
    await f.energySaving(false)
    pending.resolve({ entryId: 'entry-A', listId: 'list-A', confirmationId: 'trade-A', action: 'allow', outcome: 'accepted', requestSubmitted: true }); await f.settle()
    expect(text(f.root())).toContain('The confirmation endpoint accepted the allow request')
    expect(f.api.respond).toHaveBeenCalledOnce(); expect(f.api.list).toHaveBeenCalledOnce()
    expect(f.button('Load confirmations manually').disabled).toBe(false)
  })

  it('retains a decision result that arrives while a native dialog still leaves the main window blurred', async () => {
    const f = await fixture()
    await f.click('Load confirmations manually')
    const pending = deferred<SteamAuthenticatorConfirmationResult>()
    f.api.respond.mockReturnValueOnce(pending.promise)
    await f.click('Allow confirmation Trade with synthetic partner')
    await f.energySaving(true)
    pending.resolve({ entryId: 'entry-A', listId: 'list-A', confirmationId: 'trade-A', action: 'allow', outcome: 'unknown', requestSubmitted: true }); await f.settle()
    await f.energySaving(false)
    expect(text(f.root())).toContain('The request outcome is unconfirmed')
    expect(f.api.respond).toHaveBeenCalledOnce()
    expect(f.api.list).toHaveBeenCalledOnce()
  })

  it('escapes confirmation titles and summaries without remote HTML or image rendering', async () => {
    const f = await fixture()
    f.api.list.mockResolvedValueOnce({ ...base, items: [{ ...base.items[0]!, title: '<img src="https://evil.example/x" onerror="bad()">', summary: ['<script>bad()</script>'] }] })
    await f.click('Load confirmations manually')
    const html = renderToStaticMarkup(f.root())
    expect(html).toContain('&lt;img src=')
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('href=')
  })

  it('never prints raw failed response messages or confirmation credentials', async () => {
    const f = await fixture()
    f.api.list.mockRejectedValueOnce({ code: 'AUTH_CONFIRMATION_LIST_FAILED', message: 'nonce=secret-fixture identity_secret=private' })
    await f.click('Load confirmations manually')
    expect(text(f.root())).toContain('confirmation list could not be loaded')
    expect(text(f.root())).not.toContain('secret-fixture')
    expect(text(f.root())).not.toContain('identity_secret=')
  })

  it('keeps owner changes authoritative even if they occur during native-dialog blur', async () => {
    const f = await fixture()
    await f.click('Load confirmations manually')
    const pending = deferred<SteamAuthenticatorConfirmationResult>()
    f.api.respond.mockReturnValueOnce(pending.promise)
    await f.click('Allow confirmation Trade with synthetic partner')
    await f.energySaving(true)
    f.props.selectedSteamId = STEAM_B; f.render(); await f.settle()
    await f.energySaving(false)
    pending.resolve({ entryId: 'entry-A', listId: 'list-A', confirmationId: 'trade-A', action: 'allow', outcome: 'accepted', requestSubmitted: true }); await f.settle()
    expect(text(f.root())).not.toContain('endpoint accepted the allow request')
    expect(f.api.respond).toHaveBeenCalledOnce()
  })
})

describe('confirmation result and error wording', () => {
  it('explains that safety-record failure blocks submission without advising deletion to bypass it', () => {
    const message = steamAuthenticatorConfirmationError('AUTH_CONFIRMATION_SAFETY_UNAVAILABLE', (_zh, english) => english)
    expect(message).toContain('submission was blocked')
    expect(message).toContain('preserve the records')
    expect(message).toContain('Do not delete files to bypass')
  })
  it.each(['accepted', 'rejected', 'unknown', 'cancelled', 'stale'] as const)('does not claim trade completion for outcome %s', outcome => {
    const result: SteamAuthenticatorConfirmationResult = { entryId: 'A', listId: 'L', confirmationId: 'C', action: 'allow', outcome, requestSubmitted: outcome === 'accepted' || outcome === 'unknown' || outcome === 'rejected' }
    const en = steamAuthenticatorConfirmationResultText(result, (_zh, english) => english)
    expect(en).not.toContain('Trade completed successfully')
    expect(en).not.toMatch(/\p{Script=Han}/u)
    expect(en.endsWith('.')).toBe(false)
  })

  it.each(['INVALID', 'UNAVAILABLE', 'IDENTITY', 'CHANGED', 'EXPIRED', 'BUSY', 'UNSUPPORTED', 'LIST_FAILED', 'TIME_UNAVAILABLE', 'SAFETY_UNAVAILABLE'])('translates AUTH_CONFIRMATION_%s without echoing raw codes', suffix => {
    const code = `AUTH_CONFIRMATION_${suffix}`
    const en = steamAuthenticatorConfirmationError(code, (_zh, english) => english)
    expect(en).not.toContain(code)
    expect(en).not.toMatch(/\p{Script=Han}/u)
    expect(en.endsWith('.')).toBe(false)
  })
})
