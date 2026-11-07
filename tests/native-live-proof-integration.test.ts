import { afterEach, describe, expect, it, vi } from 'vitest'
import { DomainError } from '../src/shared/domain'
import { GameStatusService } from '../src/main/game-status-service'
import { createLiveNativeContextDetector } from '../src/main/native-context-strategy'
import { NativeGameStatusClient, type NativeGameStatusContext } from '../src/main/native-game-status-client'
import { NativePresenceError } from '../src/main/native-presence-broker'
import { nativeGameStatusFailureCode } from '../src/shared/game-status-errors'

const self = '76561198000000001'
const proof: NativeGameStatusContext = { appId: 493520, steamId: self, steamPid: 100, steamStartTicks: '638964000000000001',
  steamExe: 'D:/Steam/steam.exe', identitySource: 'native-user', gamePid: 200, gameStartTicks: '638964000000000002',
  gameExe: 'D:/Steam/steamapps/common/GTFO/GTFO.exe' }
const services: GameStatusService[] = []
afterEach(() => { for (const service of services.splice(0)) service.dispose() })

function fixture() {
  const detect = vi.fn(async () => proof)
  const cancel = vi.fn(), stop = vi.fn()
  const read = vi.fn(async () => ({ fields: { status: 'synthetic fixture' }, keyCount: 1, localizedString: null,
    displayTokenReadable: false, verificationSource: 'local-cache' as const }))
  const diagnostics = vi.fn()
  const service = new GameStatusService({
    getActiveAccount: () => ({ id: self, steamId: self }), onDiagnostic: diagnostics,
    createLocalClient: steamId => new NativeGameStatusClient({ steamId, broker: { read, stop }, cancelContextDetection: cancel,
      detectContext: createLiveNativeContextDetector(async () => { throw new DomainError('GAME_STATUS_NATIVE_DETECTION_UNAVAILABLE', 'synthetic stale registry') }, detect) })
  })
  services.push(service)
  return { service, detect, cancel, read, stop, diagnostics }
}

describe('native proof strategy and real service integration without native processes', () => {
  it('passes verified Steam/game identity into the read-only broker before declaring a local connection', async () => {
    const f = fixture()
    f.service.connectLocal({ accountId: self, sessionId: f.service.snapshot().sessionId })
    await vi.waitFor(() => expect(f.service.snapshot().connected).toBe(true))
    expect(f.read).toHaveBeenCalledExactlyOnceWith({ appId: proof.appId, steamId: self, steamPid: proof.steamPid,
      steamStartTicks: proof.steamStartTicks, identitySource: 'native-user', gamePid: proof.gamePid,
      gameStartTicks: proof.gameStartTicks, gameExe: proof.gameExe }, expect.any(Function))
    expect(f.diagnostics).toHaveBeenCalledWith(expect.objectContaining({ stage: 'local-connected', connectionKind: 'local' }))
    f.service.dispose()
    expect(f.cancel).toHaveBeenCalledOnce()
  })

  it('rejects a malformed or incomplete game proof before any broker call', async () => {
    const f = fixture()
    f.detect.mockResolvedValue({ ...proof, gameStartTicks: undefined })
    f.service.connectLocal({ accountId: self, sessionId: f.service.snapshot().sessionId })
    await vi.waitFor(() => expect(f.service.snapshot().status).toBe('error'))
    expect(f.read).not.toHaveBeenCalled()
    expect(f.service.snapshot().failure?.code).toBe('GAME_STATUS_NATIVE_DETECTION_UNAVAILABLE')
  })

  it('preserves a reviewed native failure subcode instead of exposing arbitrary exception details', async () => {
    const f = fixture()
    f.read.mockRejectedValue(new NativePresenceError('NATIVE_GAME_AMBIGUOUS'))
    f.service.connectLocal({ accountId: self, sessionId: f.service.snapshot().sessionId })
    await vi.waitFor(() => expect(f.service.snapshot().status).toBe('error'))
    expect(f.service.snapshot().failure).toMatchObject({ code: 'GAME_STATUS_NATIVE_UNAVAILABLE', nativeCode: 'NATIVE_GAME_AMBIGUOUS', submitted: 'no' })
    expect(f.diagnostics).toHaveBeenCalledWith(expect.objectContaining({ stage: 'local-connect-failed', nativeCode: 'NATIVE_GAME_AMBIGUOUS' }))
    expect(nativeGameStatusFailureCode({ nativeCode: 'PRIVATE-token-path' })).toBeUndefined()
    expect(nativeGameStatusFailureCode({ get nativeCode() { throw new Error('PRIVATE') } })).toBeUndefined()
  })
})
