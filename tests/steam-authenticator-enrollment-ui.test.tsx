import type { ReactElement, ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SteamAuthenticatorEnrollmentApi, SteamAuthenticatorEnrollmentSnapshot } from '../src/shared/steam-authenticator-enrollment'

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
import { SteamAuthenticatorEnrollmentWizard, steamAuthenticatorEnrollmentError } from '../src/renderer/src/components/SteamAuthenticatorEnrollmentWizard'

const NOW = Date.UTC(2026, 10, 10, 0, 0, 0)
const STEAM_ID = '76561198000000001'
const idle: SteamAuthenticatorEnrollmentSnapshot = { id: null, phase: 'idle', accountName: null, steamId: null, guardType: null,
  confirmationKind: null, hint: null, backupExported: false, backupAcknowledged: false, retryAt: null, entryId: null, error: null, busy: false }
const flow = (overrides: Partial<SteamAuthenticatorEnrollmentSnapshot> = {}): SteamAuthenticatorEnrollmentSnapshot => ({
  ...idle, id: 'flow-A', accountName: 'SyntheticMobile', steamId: STEAM_ID, phase: 'phone-needed', ...overrides
})
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

async function fixture(options: { initial?: SteamAuthenticatorEnrollmentSnapshot; language?: 'zh-CN' | 'en'; visible?: boolean; initialPromise?: Promise<SteamAuthenticatorEnrollmentSnapshot> } = {}) {
  vi.useFakeTimers(); vi.setSystemTime(NOW)
  const page = Object.assign(new EventTarget(), { visibilityState: 'visible' })
  vi.stubGlobal('document', page)
  hooks.language = options.language ?? 'en'
  const base = options.initial ?? idle
  const api = {
    state: vi.fn(async (): Promise<SteamAuthenticatorEnrollmentSnapshot> => base),
    login: vi.fn(async (_input: Parameters<SteamAuthenticatorEnrollmentApi['login']>[0]): Promise<SteamAuthenticatorEnrollmentSnapshot> => flow({ phase: 'guard-required', guardType: 'email' })),
    submitGuard: vi.fn(async (_input: { id: string; code: string }): Promise<SteamAuthenticatorEnrollmentSnapshot> => flow()),
    refreshLogin: vi.fn(async (_input: { id: string }): Promise<SteamAuthenticatorEnrollmentSnapshot> => flow()),
    phone: vi.fn(async (_input: Parameters<SteamAuthenticatorEnrollmentApi['phone']>[0]): Promise<SteamAuthenticatorEnrollmentSnapshot> => base),
    add: vi.fn(async (_input: { id: string }): Promise<SteamAuthenticatorEnrollmentSnapshot> => flow({ phase: 'backup-required', confirmationKind: 'sms' })),
    showRecoveryCode: vi.fn(async (_input: { id: string }): Promise<{ shown: boolean }> => ({ shown: true })),
    exportBackup: vi.fn(async (_input: { id: string }): Promise<{ exported: boolean }> => ({ exported: true })),
    acknowledgeRecoverySaved: vi.fn(async (_input: { id: string }): Promise<SteamAuthenticatorEnrollmentSnapshot> => flow({ phase: 'ready-to-finalize', confirmationKind: 'sms', backupExported: true, backupAcknowledged: true })),
    finalize: vi.fn(async (_input: { id: string; activationCode: string }): Promise<SteamAuthenticatorEnrollmentSnapshot> => flow({ phase: 'verifying', confirmationKind: 'sms', backupExported: true, backupAcknowledged: true })),
    resume: vi.fn(async (_input: { id: string }): Promise<SteamAuthenticatorEnrollmentSnapshot> => flow({ phase: 'complete', entryId: 'saved-entry-A', confirmationKind: 'sms', backupExported: true, backupAcknowledged: true })),
    pause: vi.fn(async (_input: { id: string }): Promise<SteamAuthenticatorEnrollmentSnapshot> => flow({ phase: 'paused' }))
  } satisfies SteamAuthenticatorEnrollmentApi
  if (options.initialPromise) api.state.mockReturnValueOnce(options.initialPromise)
  const props: { api: SteamAuthenticatorEnrollmentApi; visible: boolean } = { api, visible: options.visible ?? true }
  let root: ReactElement<any>
  const render = () => { hooks.cursor = 0; root = SteamAuthenticatorEnrollmentWizard(props); hooks.effects.splice(0).forEach(effect => effect()); return root }
  const settle = async () => { for (let index = 0; index < 25; index++) await Promise.resolve(); render(); for (let index = 0; index < 5; index++) await Promise.resolve(); render() }
  const button = (label: string) => {
    const found = nodes(root).find(node => node.type === 'button' && text(node.props.children) === label)
    if (!found) throw new Error(`Missing ${label}`)
    return found.props
  }
  const input = (label: string) => {
    const found = nodes(root).find(node => node.type === 'input' && node.props['aria-label'] === label)
    if (!found) throw new Error(`Missing input ${label}`)
    return found.props
  }
  const change = async (label: string, value: string) => { input(label).onChange({ target: { value } }); await settle() }
  const click = async (label: string) => { button(label).onClick(); await settle() }
  const advance = async (milliseconds: number) => { await vi.advanceTimersByTimeAsync(milliseconds); await settle() }
  render(); await settle()
  return { api, props, root: () => root, render, settle, button, input, change, click, advance,
    async hideDocument() { page.visibilityState = 'hidden'; page.dispatchEvent(new Event('visibilitychange')); await settle() },
    async energySaving(active: boolean) { energy.active = active; for (const listener of energy.listeners) listener(active); await settle() }
  }
}

describe('executable mobile enrollment UI with a synthetic adapter', () => {
  it.each(['zh-CN', 'en'] as const)('only reads state on entry and discloses its actual security boundary in %s', async language => {
    const f = await fixture({ language })
    expect(f.api.state).toHaveBeenCalledOnce()
    for (const [name, method] of Object.entries(f.api)) if (name !== 'state') expect(method).not.toHaveBeenCalled()
    expect(text(f.root())).toContain(language === 'en' ? 'Independent MobileApp authentication' : '独立 MobileApp 认证')
    expect(text(f.root())).toContain(language === 'en' ? 'Isolated tests are not live-account verification' : '隔离测试不等于真实账号验证')
    expect(text(f.root())).not.toContain(language === 'en' ? 'Enrollment confirmed by server readback' : '服务端已核对绑定完成')
  })

  it('submits only explicit independent login credentials and clears the password input immediately', async () => {
    const f = await fixture()
    await f.change('Mobile sign-in account', 'SyntheticMobile')
    await f.change('Password for this sign-in', 'Synthetic-password-fixture')
    await f.change('Expected SteamID (optional)', STEAM_ID)
    const pending = deferred<SteamAuthenticatorEnrollmentSnapshot>()
    f.api.login.mockReturnValueOnce(pending.promise)
    await f.click('Start independent mobile authentication')
    expect(f.api.login).toHaveBeenCalledExactlyOnceWith({ accountName: 'SyntheticMobile', password: 'Synthetic-password-fixture', expectedSteamId: STEAM_ID })
    expect(f.input('Password for this sign-in').value).toBe('')
    expect(f.input('Password for this sign-in').type).toBe('password')
    expect(text(f.root())).not.toContain('Synthetic-password-fixture')
    pending.resolve(flow({ phase: 'guard-required', guardType: 'email' })); await f.settle()
  })

  it('does not log in with malformed expected identity or empty credentials', async () => {
    const f = await fixture()
    await f.change('Mobile sign-in account', 'SyntheticMobile')
    await f.change('Password for this sign-in', 'Synthetic-password-fixture')
    await f.change('Expected SteamID (optional)', '123')
    await f.click('Start independent mobile authentication')
    expect(f.api.login).not.toHaveBeenCalled()
  })

  it('handles an email or existing device Guard code explicitly without caching it after submission', async () => {
    const f = await fixture({ initial: flow({ phase: 'guard-required', guardType: 'email' }) })
    await f.change('Sign-in verification code', 'ABCDE')
    await f.click('Submit sign-in code')
    expect(f.api.submitGuard).toHaveBeenCalledExactlyOnceWith({ id: 'flow-A', code: 'ABCDE' })
    expect(text(f.root())).not.toContain('ABCDE')
    expect(f.api.add).not.toHaveBeenCalled()
  })

  it('waits for explicit mobile confirmation checks without polling or pretending a code form is available', async () => {
    const f = await fixture({ initial: flow({ phase: 'guard-required', guardType: 'confirmation' }) })
    expect(nodes(f.root()).some(node => node.type === 'input')).toBe(false)
    await f.advance(60_000)
    expect(f.api.refreshLogin).not.toHaveBeenCalled()
    await f.click('Check sign-in confirmation')
    expect(f.api.refreshLogin).toHaveBeenCalledExactlyOnceWith({ id: 'flow-A' })
  })

  it('never sends SMS automatically and requires an explicit phone-status check before sending', async () => {
    const f = await fixture({ initial: flow({ phase: 'sms-required' }) })
    expect(f.button('Send verification SMS explicitly').disabled).toBe(true)
    await f.click('Send verification SMS explicitly')
    expect(f.api.phone).not.toHaveBeenCalled()
    await f.click('Check phone and email status')
    expect(f.api.phone).toHaveBeenCalledExactlyOnceWith({ id: 'flow-A', op: 'status' })
    expect(f.button('Send verification SMS explicitly').disabled).toBe(false)
    await f.click('Send verification SMS explicitly')
    expect(f.api.phone).toHaveBeenLastCalledWith({ id: 'flow-A', op: 'send-sms' })
    await f.advance(60_000)
    expect(f.api.phone).toHaveBeenCalledTimes(2)
  })

  it('requires phone data and calling code digits, not an implicit ISO-country conversion', async () => {
    const f = await fixture({ initial: flow({ phase: 'phone-needed' }) })
    await f.change('Full international phone number', '+8613800000000')
    await f.change('Calling code', '86')
    await f.click('Check phone and email status')
    await f.click('Request this phone number')
    expect(f.api.phone).toHaveBeenLastCalledWith({ id: 'flow-A', op: 'begin', phoneNumber: '+8613800000000', countryCode: '86' })
  })

  it('allows an explicit phone-needed Add attempt without promising email or phone-free enrollment', async () => {
    const f = await fixture({ initial: flow({ phase: 'phone-needed' }) })
    expect(f.api.add).not.toHaveBeenCalled()
    expect(text(f.root())).toContain('does not guarantee phone-free enrollment')
    await f.click('Try enrollment using the method Steam permits')
    expect(f.api.add).toHaveBeenCalledExactlyOnceWith({ id: 'flow-A' })
    expect(f.api.phone).not.toHaveBeenCalled()
    expect(f.api.finalize).not.toHaveBeenCalled()
  })

  it('does not open another Add attempt in an already-started email or phone SMS flow', async () => {
    const f = await fixture({ initial: flow({ phase: 'email-required' }) })
    expect(nodes(f.root()).some(node => node.type === 'button' && text(node.props.children) === 'Try enrollment using the method Steam permits')).toBe(false)
    expect(f.api.add).not.toHaveBeenCalled()
  })

  it('respects a definite server phone requirement without labelling it an uncertain successful Add', async () => {
    const f = await fixture({ initial: flow({ phase: 'phone-needed', error: 'AUTH_ENROLL_MOBILE_PHONE_REQUIRED' }) })
    expect(f.button('Try enrollment using the method Steam permits').disabled).toBe(true)
    await f.click('Try enrollment using the method Steam permits')
    expect(f.api.add).not.toHaveBeenCalled()
    expect(text(f.root())).toContain('Steam currently requires phone verification')
    expect(text(f.root())).not.toContain('another Add is forbidden')
  })

  it('keeps the email step read-only until the user explicitly checks its completion', async () => {
    const f = await fixture({ initial: flow({ phase: 'email-required' }) })
    expect(text(f.root())).toContain('SMS is not sent automatically')
    expect(nodes(f.root()).some(node => node.type === 'button' && text(node.props.children) === 'Send verification SMS explicitly')).toBe(false)
    expect(f.api.phone).not.toHaveBeenCalled()
  })

  it('submits phone SMS only from its designated stage and then clears it', async () => {
    const f = await fixture({ initial: flow({ phase: 'sms-required' }) })
    await f.change('Phone-verification SMS code', '123456')
    f.api.phone.mockResolvedValueOnce(flow({ phase: 'ready-to-add' }))
    await f.click('Submit phone SMS code')
    expect(f.api.phone).toHaveBeenCalledExactlyOnceWith({ id: 'flow-A', op: 'submit-sms', code: '123456' })
    expect(text(f.root())).not.toContain('123456')
    expect(f.api.add).not.toHaveBeenCalled()
  })

  it('requests Add once only on click and does not automatically finalize returned pending material', async () => {
    const f = await fixture({ initial: flow({ phase: 'ready-to-add' }) })
    const click = f.button('Confirm and add authenticator once').onClick
    click(); click(); await f.settle()
    expect(f.api.add).toHaveBeenCalledExactlyOnceWith({ id: 'flow-A' })
    expect(f.api.finalize).not.toHaveBeenCalled()
    expect(text(f.root())).toContain('Recovery code and backup must be saved first')
    click(); await f.settle()
    expect(f.api.add).toHaveBeenCalledOnce()
  })

  it('keeps an authorized Add alive through native-confirmation focus blur and accepts its result once', async () => {
    const f = await fixture({ initial: flow({ phase: 'ready-to-add' }) })
    const pending = deferred<SteamAuthenticatorEnrollmentSnapshot>()
    f.api.add.mockReturnValueOnce(pending.promise)
    await f.click('Confirm and add authenticator once')
    await f.energySaving(true)
    await f.energySaving(false)
    pending.resolve(flow({ phase: 'backup-required', confirmationKind: 'sms' })); await f.settle()
    expect(text(f.root())).toContain('Recovery code and backup must be saved first')
    expect(f.button('Save sensitive recovery backup').disabled).toBe(false)
    expect(f.api.add).toHaveBeenCalledOnce()
    expect(f.api.state).toHaveBeenCalledOnce()
    expect(f.api.finalize).not.toHaveBeenCalled()
  })

  it('records backup export completion even if the native save dialog still leaves the main window blurred', async () => {
    const f = await fixture({ initial: flow({ phase: 'backup-required', confirmationKind: 'sms' }) })
    const pending = deferred<{ exported: boolean }>()
    f.api.exportBackup.mockReturnValueOnce(pending.promise)
    f.api.state.mockResolvedValueOnce(flow({ phase: 'backup-required', confirmationKind: 'sms', backupExported: true }))
    await f.click('Save sensitive recovery backup')
    await f.energySaving(true)
    pending.resolve({ exported: true }); await f.settle()
    await f.energySaving(false)
    expect(text(f.root())).toContain('Backup saving is recorded by the main process')
    expect(text(f.root())).toContain('The sensitive backup was saved')
    expect(f.api.exportBackup).toHaveBeenCalledOnce()
    expect(f.api.acknowledgeRecoverySaved).not.toHaveBeenCalled()
  })

  it('reads a visible busy snapshot until Main finishes without replaying Add or Finalize', async () => {
    const f = await fixture({ initial: flow({ phase: 'adding', busy: true }) })
    f.api.state.mockResolvedValueOnce(flow({ phase: 'adding', busy: true }))
    f.api.state.mockResolvedValueOnce(flow({ phase: 'backup-required', confirmationKind: 'sms' }))
    await f.advance(2_000)
    expect(text(f.root())).toContain('Recovery code and backup must be saved first')
    expect(f.button('Save sensitive recovery backup').disabled).toBe(false)
    expect(f.api.state).toHaveBeenCalledTimes(3)
    expect(f.api.add).not.toHaveBeenCalled(); expect(f.api.finalize).not.toHaveBeenCalled()
    await f.advance(5_000)
    expect(f.api.state).toHaveBeenCalledTimes(3)
  })

  it('stops visible-busy reads while focus energy saving is active and resumes only readback on focus', async () => {
    const f = await fixture({ initial: flow({ phase: 'adding', busy: true }) })
    await f.energySaving(true)
    expect(vi.getTimerCount()).toBe(0)
    await f.advance(60_000)
    expect(f.api.state).toHaveBeenCalledOnce()
    f.api.state.mockResolvedValueOnce(flow({ phase: 'backup-required', confirmationKind: 'sms' }))
    await f.energySaving(false)
    await f.advance(1_000)
    expect(f.api.state).toHaveBeenCalledTimes(2)
    expect(f.api.add).not.toHaveBeenCalled(); expect(f.api.finalize).not.toHaveBeenCalled()
    expect(f.button('Save sensitive recovery backup').disabled).toBe(false)
  })

  it('preserves a Finalize response across native-dialog blur without replaying activation', async () => {
    const f = await fixture({ initial: flow({ phase: 'ready-to-finalize', confirmationKind: 'sms', backupExported: true, backupAcknowledged: true }) })
    const pending = deferred<SteamAuthenticatorEnrollmentSnapshot>()
    f.api.finalize.mockReturnValueOnce(pending.promise)
    await f.change('Activation verification code', '123456')
    await f.click('Submit activation code and verify')
    await f.energySaving(true)
    await f.energySaving(false)
    pending.resolve(flow({ phase: 'complete', entryId: 'saved-entry-A' })); await f.settle()
    expect(text(f.root())).toContain('Server readback confirms enrollment')
    expect(f.api.finalize).toHaveBeenCalledOnce()
    expect(f.api.resume).not.toHaveBeenCalled()
  })

  it('stops busy-state observation on actual hiding and does not reissue the hidden Add', async () => {
    const f = await fixture({ initial: flow({ phase: 'adding', busy: true }) })
    await f.hideDocument()
    expect(vi.getTimerCount()).toBe(0)
    await f.advance(60_000)
    expect(f.api.state).toHaveBeenCalledOnce()
    expect(f.api.add).not.toHaveBeenCalled()
    expect(f.api.finalize).not.toHaveBeenCalled()
  })

  it('reads the saved uncertainty state after an Add failure without resending Add', async () => {
    const f = await fixture({ initial: flow({ phase: 'ready-to-add' }) })
    f.api.add.mockRejectedValueOnce({ code: 'AUTHENTICATOR_ENROLLMENT_ADD_UNCERTAIN' })
    f.api.state.mockResolvedValueOnce(flow({ phase: 'add-uncertain', error: 'AUTHENTICATOR_ENROLLMENT_ADD_UNCERTAIN' }))
    await f.click('Confirm and add authenticator once')
    expect(f.api.add).toHaveBeenCalledOnce()
    expect(f.api.state).toHaveBeenCalledTimes(2)
    expect(text(f.root())).toContain('another Add is forbidden')
    expect(nodes(f.root()).some(node => node.type === 'button' && text(node.props.children) === 'Confirm and add authenticator once')).toBe(false)
    await f.advance(60_000)
    expect(f.api.add).toHaveBeenCalledOnce()
  })

  it('labels quarantined rescue material as incomplete and permits only native rescue actions', async () => {
    const initial = flow({ phase: 'add-uncertain', hasRescueMaterials: true, error: 'AUTHENTICATOR_ENROLLMENT_ADD_UNCERTAIN' })
    const f = await fixture({ initial })
    expect(text(f.root())).toContain('Received material was quarantined and encrypted')
    expect(text(f.root())).toContain('It is not an enrolled authenticator')
    expect(nodes(f.root()).some(node => node.type === 'button' && text(node.props.children) === 'Confirm and add authenticator once')).toBe(false)
    expect(nodes(f.root()).some(node => node.type === 'button' && text(node.props.children) === 'Submit activation code and verify')).toBe(false)
    expect(nodes(f.root()).some(node => node.type === 'input' && node.props.type === 'checkbox')).toBe(false)
    f.api.state.mockResolvedValueOnce({ ...initial, backupExported: true })
    await f.click('Save quarantined rescue material')
    expect(f.api.exportBackup).toHaveBeenCalledExactlyOnceWith({ id: 'flow-A' })
    expect(text(f.root())).toContain('this is not a backup of a successfully enrolled authenticator')
    expect(text(f.root())).not.toContain('you must still explicitly acknowledge')
    expect(f.api.add).not.toHaveBeenCalled(); expect(f.api.finalize).not.toHaveBeenCalled(); expect(f.api.acknowledgeRecoverySaved).not.toHaveBeenCalled()
  })

  it('does not invent a missing recovery code when quarantined material cannot show one', async () => {
    const f = await fixture({ initial: flow({ phase: 'add-uncertain', hasRescueMaterials: true }) })
    f.api.showRecoveryCode.mockRejectedValueOnce({ code: 'AUTHENTICATOR_ENROLLMENT_MATERIAL_UNAVAILABLE' })
    await f.click('Show recovery code in native window')
    expect(text(f.root())).toContain('Missing values are never invented')
    expect(text(f.root())).not.toContain('The recovery code was shown in a native window')
  })

  it('does not claim rescue data was durably encrypted when persistence failed', async () => {
    const f = await fixture({ initial: flow({ phase: 'add-uncertain', hasRescueMaterials: true, error: 'AUTHENTICATOR_ENROLLMENT_PERSISTENCE_FAILED' }) })
    expect(text(f.root())).toContain('encrypted persistence is unconfirmed')
    expect(text(f.root())).toContain('Do not exit, clear records or repeat Add')
    expect(text(f.root())).not.toContain('Received material was quarantined and encrypted')
  })

  it('labels optional SDA metadata as incomplete without inventing a full backup or blocking valid core material', async () => {
    const f = await fixture({ initial: flow({ phase: 'ready-to-finalize', confirmationKind: 'email', backupExported: true, backupAcknowledged: true, metadataIncomplete: true }) })
    expect(text(f.root())).toContain('must not be labelled a full SDA backup')
    await f.change('Activation verification code', '123456')
    expect(f.button('Submit activation code and verify').disabled).toBe(false)
    expect(f.api.finalize).not.toHaveBeenCalled()
  })

  it('never finalizes quarantined material even if a malformed snapshot carries completed backup flags', async () => {
    const f = await fixture({ initial: flow({ phase: 'ready-to-finalize', confirmationKind: 'sms', hasRescueMaterials: true, backupExported: true, backupAcknowledged: true }) })
    await f.change('Activation verification code', '123456')
    expect(f.button('Submit activation code and verify').disabled).toBe(true)
    await f.click('Submit activation code and verify')
    expect(f.api.finalize).not.toHaveBeenCalled()
  })

  it('shows recovery codes only through the native action and does not treat viewing as saved backup proof', async () => {
    const f = await fixture({ initial: flow({ phase: 'backup-required', confirmationKind: 'sms' }) })
    await f.click('Show recovery code in native window')
    expect(f.api.showRecoveryCode).toHaveBeenCalledExactlyOnceWith({ id: 'flow-A' })
    expect(text(f.root())).toContain('not returned to this page')
    expect(f.button('Confirm recovery material is safely saved').disabled).toBe(true)
    expect(f.api.acknowledgeRecoverySaved).not.toHaveBeenCalled()
  })

  it('requires backend-recorded backup export and explicit user acknowledgment before enabling activation', async () => {
    const f = await fixture({ initial: flow({ phase: 'backup-required', confirmationKind: 'sms' }) })
    expect(f.button('Confirm recovery material is safely saved').disabled).toBe(true)
    f.api.state.mockResolvedValueOnce(flow({ phase: 'backup-required', confirmationKind: 'sms', backupExported: true }))
    await f.click('Save sensitive recovery backup')
    expect(f.api.exportBackup).toHaveBeenCalledExactlyOnceWith({ id: 'flow-A' })
    expect(f.button('Confirm recovery material is safely saved').disabled).toBe(true)
    nodes(f.root()).find(node => node.type === 'input' && node.props.type === 'checkbox')!.props.onChange({ target: { checked: true } }); await f.settle()
    await f.click('Confirm recovery material is safely saved')
    expect(f.api.acknowledgeRecoverySaved).toHaveBeenCalledExactlyOnceWith({ id: 'flow-A' })
    expect(f.button('Submit activation code and verify').disabled).toBe(true)
    expect(f.api.finalize).not.toHaveBeenCalled()
  })

  it('does not mark a cancelled native backup export successful or set the export flag locally', async () => {
    const f = await fixture({ initial: flow({ phase: 'backup-required', confirmationKind: 'sms' }) })
    f.api.exportBackup.mockResolvedValueOnce({ exported: false })
    await f.click('Save sensitive recovery backup')
    expect(text(f.root())).not.toContain('The sensitive backup was saved')
    expect(f.api.state).toHaveBeenCalledOnce()
    expect(f.button('Confirm recovery material is safely saved').disabled).toBe(true)
  })

  it('allows native recovery display for saved pending material even when a mobile session needs reauthentication', async () => {
    const f = await fixture({ initial: flow({ phase: 'login-required', confirmationKind: 'sms' }) })
    await f.click('Show recovery code in native window')
    expect(f.api.showRecoveryCode).toHaveBeenCalledWith({ id: 'flow-A' })
    expect(f.api.login).not.toHaveBeenCalled()
  })

  it('blocks unknown activation confirmation types while preserving native backup and recovery access', async () => {
    const f = await fixture({ initial: flow({ phase: 'ready-to-finalize', confirmationKind: 'unknown', backupExported: true, backupAcknowledged: true }) })
    expect(text(f.root())).toContain('Finalize is disabled')
    expect(nodes(f.root()).some(node => node.type === 'button' && text(node.props.children) === 'Submit activation code and verify')).toBe(false)
    await f.click('Show recovery code in native window')
    expect(f.api.showRecoveryCode).toHaveBeenCalledOnce()
    expect(f.api.finalize).not.toHaveBeenCalled()
  })

  it('does not finalize on a local checkbox without server-backed saved and acknowledged flags', async () => {
    const f = await fixture({ initial: flow({ phase: 'ready-to-finalize', confirmationKind: 'sms', backupExported: false, backupAcknowledged: false }) })
    await f.change('Activation verification code', '123456')
    await f.click('Submit activation code and verify')
    expect(f.api.finalize).not.toHaveBeenCalled()
  })

  it('submits activation explicitly, clears the code, and does not claim success before server verification', async () => {
    const f = await fixture({ initial: flow({ phase: 'ready-to-finalize', confirmationKind: 'sms', backupExported: true, backupAcknowledged: true }) })
    await f.change('Activation verification code', '123456')
    await f.click('Submit activation code and verify')
    expect(f.api.finalize).toHaveBeenCalledExactlyOnceWith({ id: 'flow-A', activationCode: '123456' })
    expect(text(f.root())).toContain('Server-state verification needed')
    expect(text(f.root())).not.toContain('Server readback confirms enrollment')
    expect(f.api.resume).not.toHaveBeenCalled()
    await f.click('Read back server enrollment state')
    expect(f.api.resume).toHaveBeenCalledExactlyOnceWith({ id: 'flow-A' })
    expect(text(f.root())).toContain('Server readback confirms enrollment')
  })

  it('starts another account only after completion and another explicit independent sign-in', async () => {
    const f = await fixture({ initial: flow({ phase: 'complete', entryId: 'saved-entry-A' }) })
    await f.click('Enroll another account')
    expect(f.api.login).not.toHaveBeenCalled()
    expect(f.input('Mobile sign-in account').value).toBe('')
    expect(f.input('Expected SteamID (optional)').value).toBe('')
    expect(text(f.root())).toContain('the new target has not authenticated yet')
    await f.change('Mobile sign-in account', 'SyntheticOther')
    await f.change('Password for this sign-in', 'Synthetic-password-fixture')
    await f.click('Start independent mobile authentication')
    expect(f.api.login).toHaveBeenCalledExactlyOnceWith({ accountName: 'SyntheticOther', password: 'Synthetic-password-fixture' })
  })

  it('observes a Finalize retry deadline without automatic activation or network polling', async () => {
    const f = await fixture({ initial: flow({ phase: 'finalize-wait', confirmationKind: 'email', backupExported: true, backupAcknowledged: true, retryAt: NOW + 30_000 }) })
    await f.change('Activation verification code', '123456')
    expect(f.button('Submit activation code and verify').disabled).toBe(true)
    await f.advance(30_000)
    expect(f.button('Submit activation code and verify').disabled).toBe(false)
    expect(f.api.finalize).not.toHaveBeenCalled()
    expect(f.api.state).toHaveBeenCalledOnce()
    await f.click('Submit activation code and verify')
    expect(f.api.finalize).toHaveBeenCalledOnce()
  })

  it('does not export a new backup in verification or retry-wait stages and accidentally roll back the flow', async () => {
    const f = await fixture({ initial: flow({ phase: 'verifying', confirmationKind: 'sms', backupExported: true, backupAcknowledged: true }) })
    expect(f.button('Save sensitive recovery backup').disabled).toBe(true)
    expect(f.button('Show recovery code in native window').disabled).toBe(false)
  })

  it('keeps a read-only state refresh available when an earlier view observed a busy backend', async () => {
    const f = await fixture({ initial: flow({ phase: 'adding', busy: true }) })
    expect(f.button('Read flow state').disabled).toBe(false)
    f.api.state.mockResolvedValueOnce(flow({ phase: 'backup-required', confirmationKind: 'sms' }))
    await f.click('Read flow state')
    expect(text(f.root())).toContain('Recovery code and backup must be saved first')
    expect(f.api.add).not.toHaveBeenCalled()
  })

  it('does not read or start any flow while its tab is hidden', async () => {
    const f = await fixture({ visible: false })
    await f.advance(60_000)
    expect(f.api.state).not.toHaveBeenCalled()
    expect(f.api.login).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('ignores late login results and clears inputs after hiding and reopening', async () => {
    const f = await fixture()
    await f.change('Mobile sign-in account', 'SyntheticMobile')
    await f.change('Password for this sign-in', 'Synthetic-password-fixture')
    const pending = deferred<SteamAuthenticatorEnrollmentSnapshot>()
    f.api.login.mockReturnValueOnce(pending.promise)
    await f.click('Start independent mobile authentication')
    f.props.visible = false; f.render(); await f.settle()
    f.props.visible = true; f.render(); await f.settle()
    pending.resolve(flow({ phase: 'complete', entryId: 'should-not-show' })); await f.settle()
    expect(text(f.root())).not.toContain('Server readback confirms enrollment')
    expect(f.input('Password for this sign-in').value).toBe('')
  })

  it('clears sensitive input and deadline timers on document hiding without automatically pausing or resuming Main work', async () => {
    const f = await fixture({ initial: flow({ phase: 'finalize-wait', confirmationKind: 'sms', backupExported: true, backupAcknowledged: true, retryAt: NOW + 30_000 }) })
    await f.change('Activation verification code', '123456')
    await f.hideDocument()
    expect(vi.getTimerCount()).toBe(0)
    expect(text(f.root())).not.toContain('123456')
    expect(f.api.pause).not.toHaveBeenCalled()
    expect(f.api.resume).not.toHaveBeenCalled()
    expect(f.api.finalize).not.toHaveBeenCalled()
  })

  it('escapes safe hints and never prints arbitrary backend error messages or key material', async () => {
    const f = await fixture({ initial: flow({ phase: 'ready-to-add', hint: '<img onerror="bad()">' }) })
    f.api.add.mockRejectedValueOnce({ code: 'AUTHENTICATOR_ENROLLMENT_ADD_UNCERTAIN', message: 'shared_secret=private-secret-fixture' })
    await f.click('Confirm and add authenticator once')
    const html = renderToStaticMarkup(f.root())
    expect(html).toContain('&lt;img onerror=')
    expect(html).not.toContain('<img onerror=')
    expect(html).not.toContain('private-secret-fixture')
    expect(html).not.toContain('shared_secret=')
  })

  it.each(['BACKUP_REQUIRED', 'ADD_UNCERTAIN', 'PERSISTENCE_FAILED', 'CONFIRM_TYPE_UNSUPPORTED', 'STATUS_UNCONFIRMED',
    'ACTIVATION_REJECTED', 'CHANGED', 'BUSY', 'STATE_INVALID', 'IDENTITY', 'INVALID', 'UNAVAILABLE'])('translates stable enrollment %s without leaking raw values', suffix => {
    const message = steamAuthenticatorEnrollmentError(`AUTHENTICATOR_ENROLLMENT_${suffix}`, (_zh, en) => en)
    expect(message).not.toContain('AUTHENTICATOR_')
    expect(message).not.toMatch(/\p{Script=Han}/u)
    expect(message.endsWith('.')).toBe(false)
  })
})
