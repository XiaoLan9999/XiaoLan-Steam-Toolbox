import { afterEach, describe, expect, it, vi } from 'vitest'
import { DomainError } from '../src/shared/domain'
import type { LocalAppDiagnosticEvent } from '../src/shared/local-app-diagnostics'
import { LocalAppSimulationService, type LocalAppSimulationHost } from '../src/main/local-app-simulation'
import type { LocalAppSimulationContext } from '../src/main/local-app-simulation-context'

const account = { id: 'synthetic-local-account', steamId: '76561198000000001' }
const context: LocalAppSimulationContext = { appId: 0, steamId: account.steamId, steamPid: 1234,
  steamStartTicks: '638965000000000001', steamExe: 'D:/SyntheticSteam/steam.exe', ownerPid: 5678,
  ownerStartTicks: '638965000000000002', activeAppIds: [] }
const read = { fields: {}, localizedString: null, verificationSource: 'local-cache' as const }
const cleanups: Array<() => Promise<void>> = []

function fixture(observer?: (event: LocalAppDiagnosticEvent) => void) {
  const events: LocalAppDiagnosticEvent[] = []
  let exit: (error: DomainError) => void = () => undefined
  const host: LocalAppSimulationHost = {
    begin: vi.fn(async (_context, _app, permitted) => { expect(permitted()).toBe(true); return read }),
    apply: vi.fn(async (_changes, permitted) => { expect(permitted()).toBe(true); return read }),
    read: vi.fn(async permitted => { expect(permitted()).toBe(true); return read }),
    stop: vi.fn(), shutdown: vi.fn(async () => undefined), onExit: listener => { exit = listener; return () => undefined }
  }
  const detector = vi.fn(async () => structuredClone(context))
  const service = new LocalAppSimulationService({ getActiveAccount: () => account,
    getWorkerPath: () => 'D:/SyntheticSteam/local-app-host.exe', host, readContext: detector,
    onDiagnostic: event => { events.push(event); observer?.(event) } })
  cleanups.push(() => service.shutdown())
  const action = () => ({ accountId: account.id, sessionId: service.state().sessionId })
  return { service, host, detector, events, action, exit: (code: string) => exit(new DomainError(code, 'synthetic-private-native-output')) }
}

afterEach(async () => { for (const close of cleanups.splice(0)) await close(); vi.useRealTimers() })

describe('local simulation monitor reliability', () => {
  it('keeps the same host through one transient external read failure and records recovery', async () => {
    vi.useFakeTimers()
    const f = fixture()
    await f.service.start({ ...f.action(), appId: 4000 })
    f.detector.mockRejectedValueOnce(new Error('synthetic-private-cim-error'))
    await vi.advanceTimersByTimeAsync(3000)
    expect(f.service.state()).toMatchObject({ status: 'running', appId: 4000, error: null })
    expect(f.host.stop).not.toHaveBeenCalled()
    expect(f.events).toContainEqual(expect.objectContaining({ stage: 'monitor-retry', count: 1, code: 'LOCAL_APP_CONTEXT_UNAVAILABLE' }))
    await vi.advanceTimersByTimeAsync(3000)
    expect(f.events).toContainEqual(expect.objectContaining({ stage: 'monitor-recovered', count: 1 }))
    expect(f.host.begin).toHaveBeenCalledOnce()
    expect(f.host.apply).not.toHaveBeenCalled()
    expect(JSON.stringify(f.events)).not.toContain('synthetic-private')
  })

  it('allows at most two temporary failures and then stops on the third consecutive failure', async () => {
    vi.useFakeTimers()
    const f = fixture()
    await f.service.start({ ...f.action(), appId: 4000 })
    f.detector.mockRejectedValue(new Error('synthetic-cim-error'))
    await vi.advanceTimersByTimeAsync(6000)
    expect(f.service.state().status).toBe('running')
    expect(f.host.stop).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(3000)
    expect(f.service.state()).toMatchObject({ status: 'error', error: { code: 'LOCAL_APP_CONTEXT_UNAVAILABLE' } })
    expect(f.host.stop).toHaveBeenCalledOnce()
    expect(f.events).toContainEqual(expect.objectContaining({ stage: 'monitor-stop', count: 3 }))
    const checks = f.detector.mock.calls.length
    await vi.advanceTimersByTimeAsync(30_000)
    expect(f.detector).toHaveBeenCalledTimes(checks)
    expect(f.host.begin).toHaveBeenCalledOnce()
  })

  it('resets the transient failure budget after a successful observation', async () => {
    vi.useFakeTimers()
    const f = fixture()
    await f.service.start({ ...f.action(), appId: 4000 })
    for (let cycle = 0; cycle < 3; cycle++) {
      f.detector.mockRejectedValueOnce(new Error('synthetic')).mockRejectedValueOnce(new Error('synthetic'))
      await vi.advanceTimersByTimeAsync(9000)
      expect(f.service.state().status).toBe('running')
    }
    expect(f.host.stop).not.toHaveBeenCalled()
    expect(f.events.filter(event => event.stage === 'monitor-recovered')).toHaveLength(3)
  })

  it.each([{ steamId: '76561198000000002' }, { steamPid: 1235 }, { ownerPid: 5679 }])(
    'immediately stops on a confirmed binding change even during a transient grace period: %j', async changed => {
      vi.useFakeTimers()
      const f = fixture()
      await f.service.start({ ...f.action(), appId: 4000 })
      f.detector.mockRejectedValueOnce(new Error('synthetic'))
      await vi.advanceTimersByTimeAsync(3000)
      f.detector.mockResolvedValueOnce({ ...context, ...changed })
      await vi.advanceTimersByTimeAsync(3000)
      expect(f.service.state()).toMatchObject({ status: 'error', error: { code: 'LOCAL_APP_CONTEXT_CHANGED' } })
      expect(f.host.stop).toHaveBeenCalledOnce()
      expect(f.host.begin).toHaveBeenCalledOnce()
    })

  it('retains the actual worker failure when an old in-flight monitor later rejects', async () => {
    vi.useFakeTimers()
    const f = fixture()
    await f.service.start({ ...f.action(), appId: 4000 })
    let reject!: (error: unknown) => void
    f.detector.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
    await vi.advanceTimersByTimeAsync(3000)
    f.exit('LOCAL_APP_TIMEOUT')
    reject(new Error('synthetic late monitor failure'))
    await vi.advanceTimersByTimeAsync(0)
    expect(f.service.state()).toMatchObject({ status: 'error', error: { code: 'LOCAL_APP_TIMEOUT' } })
    expect(f.events.some(event => event.stage === 'invalidated' && event.reason === 'account-change')).toBe(false)
  })

  it('keeps start and write context checks strict rather than reusing the background grace period', async () => {
    const f = fixture()
    f.detector.mockRejectedValueOnce(new Error('synthetic startup failure'))
    await expect(f.service.start({ ...f.action(), appId: 4000 })).rejects.toMatchObject({ code: 'LOCAL_APP_CONTEXT_UNAVAILABLE' })
    expect(f.host.begin).not.toHaveBeenCalled()
    expect(f.host.apply).not.toHaveBeenCalled()
  })

  it('can remain running beyond fifteen minutes without an artificial total lifetime', async () => {
    vi.useFakeTimers()
    const f = fixture(() => { throw new Error('synthetic observer failure') })
    await f.service.start({ ...f.action(), appId: 4000 })
    await vi.advanceTimersByTimeAsync(16 * 60 * 1000)
    expect(f.service.state()).toMatchObject({ status: 'running', appId: 4000, error: null })
    expect(f.host.stop).not.toHaveBeenCalled()
    expect(f.host.begin).toHaveBeenCalledOnce()
  })
})
