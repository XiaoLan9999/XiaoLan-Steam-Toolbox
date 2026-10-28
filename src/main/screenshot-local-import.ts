import * as path from 'node:path'
import { DomainError } from '../shared/domain'
import type { ScreenshotPrepareInput, ScreenshotPrepareResult } from '../shared/steam-screenshots'
import type { ScreenshotActiveUser } from './screenshot-active-user'
import type { SteamScreenshotService } from './steam-screenshots'

export type ScreenshotInactivePermit = Readonly<object>
interface Authorization {
  service: SteamScreenshotService
  input: string
  current: ScreenshotActiveUser
  readActiveUser(steamPath: string): Promise<ScreenshotActiveUser>
}
const permits = new WeakMap<ScreenshotInactivePermit, Authorization>()
const steamIdBase = 76_561_197_960_265_728n
const samePath = (a: string, b: string): boolean => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
const unavailable = (): DomainError => new DomainError('SCREENSHOT_ACTIVE_USER_UNAVAILABLE', '无法可靠核实本机 Steam 当前账号，未写入截图；请等待登录完成后重试')
const changed = (): DomainError => new DomainError('SCREENSHOT_ACTIVE_USER_CHANGED', 'Steam 当前账号或客户端实例已变化，已停止指定账号的本地截图导入，请刷新后重试')
const invalid = (): DomainError => new DomainError('SCREENSHOT_INACTIVE_AUTHORIZATION_INVALID', '非当前账号导入授权无效，未继续写入截图')

function fingerprint(input: ScreenshotPrepareInput): string {
  return JSON.stringify([input.mode, input.steamPath, input.userId, input.appId, input.imageIds,
    input.jpegQuality, input.resizeLargeImages, input.caption ?? '', input.restartSteam, input.preferLive])
}

function validIdentity(value: ScreenshotActiveUser, steamPath: string): boolean {
  return !!value && typeof value.steamPath === 'string' && typeof value.steamExe === 'string' &&
    path.isAbsolute(value.steamPath) && path.isAbsolute(value.steamExe) && samePath(value.steamPath, steamPath) &&
    samePath(path.dirname(value.steamExe), steamPath) && path.basename(value.steamExe).toLowerCase() === 'steam.exe' &&
    Number.isSafeInteger(value.steamPid) && value.steamPid > 0 && value.steamPid <= 0xffffffff &&
    typeof value.steamStartTicks === 'string' && /^[1-9]\d{1,18}$/.test(value.steamStartTicks) &&
    typeof value.steamId === 'string' && /^\d{17}$/.test(value.steamId) &&
    BigInt(value.steamId) > steamIdBase && BigInt(value.steamId) <= steamIdBase + 0xffffffffn &&
    typeof value.clientSha256 === 'string' && /^[a-f0-9]{64}$/.test(value.clientSha256)
}

async function currentIdentity(read: Authorization['readActiveUser'], steamPath: string): Promise<ScreenshotActiveUser> {
  try {
    const value = await read(steamPath)
    if (!validIdentity(value, steamPath)) throw unavailable()
    return { ...value }
  } catch { throw unavailable() }
}

export function consumeScreenshotInactivePermit(permit: ScreenshotInactivePermit, service: SteamScreenshotService,
  input: ScreenshotPrepareInput): () => Promise<void> {
  const authorization = permit && typeof permit === 'object' ? permits.get(permit) : undefined
  if (authorization) permits.delete(permit)
  if (!authorization || authorization.service !== service || input.mode !== 'local-account' || authorization.input !== fingerprint(input)) throw invalid()
  const target = String(steamIdBase + BigInt(input.userId))
  if (target === authorization.current.steamId) throw invalid()
  return async () => {
    if (authorization.input !== fingerprint(input)) throw invalid()
    const current = await currentIdentity(authorization.readActiveUser, input.steamPath)
    const original = authorization.current
    if (current.steamId === target || current.steamId !== original.steamId || current.steamPid !== original.steamPid ||
        current.steamStartTicks !== original.steamStartTicks || !samePath(current.steamExe, original.steamExe) ||
        !samePath(current.steamPath, original.steamPath) || current.clientSha256 !== original.clientSha256) throw changed()
  }
}

export class ScreenshotLocalImport {
  private busy = false
  constructor(private readonly options: {
    service: SteamScreenshotService
    readActiveUser(steamPath: string): Promise<ScreenshotActiveUser>
  }) {}

  async assertCurrentTarget(input: ScreenshotPrepareInput, client?: { pid: number; startTicks: string; executable: string }): Promise<void> {
    if (!input || typeof input.userId !== 'string' || !/^[1-9]\d{0,9}$/.test(input.userId) || BigInt(input.userId) > 0xffffffffn ||
        typeof input.steamPath !== 'string' || !path.isAbsolute(input.steamPath)) throw invalid()
    const current = await currentIdentity(this.options.readActiveUser, input.steamPath)
    if (client && (current.steamPid !== client.pid || current.steamStartTicks !== client.startTicks || !samePath(current.steamExe, client.executable))) {
      throw new DomainError('SCREENSHOT_TARGET_CHANGED', 'Steam 客户端已变化，未继续当前账号截图操作，请刷新后重试')
    }
    if (current.steamId !== String(steamIdBase + BigInt(input.userId))) {
      throw new DomainError(client ? 'SCREENSHOT_TARGET_CHANGED' : 'SCREENSHOT_TARGET_NOT_CURRENT',
        '所选目标不是当前 Steam 登录账号；请先切换 Steam 账号，或选择模式二进行指定账号本地导入')
    }
  }

  async prepareIfInactive(input: ScreenshotPrepareInput): Promise<ScreenshotPrepareResult | null> {
    if (this.busy) throw new DomainError('SCREENSHOT_BUSY', '指定账号截图导入正在进行，请稍后重试')
    if (input?.mode !== 'local-account') throw invalid()
    this.busy = true
    let permit: ScreenshotInactivePermit | undefined
    try {
      await this.options.service.preflight(input)
      const current = await currentIdentity(this.options.readActiveUser, input.steamPath)
      if (current.steamId === String(steamIdBase + BigInt(input.userId))) return null
      permit = Object.freeze({})
      permits.set(permit, { service: this.options.service, input: fingerprint(input), current, readActiveUser: this.options.readActiveUser })
      const result = await this.options.service.prepareInactive(input, permit)
      return { ...result, method: 'index', activation: 'after-account-switch', completedImageIds: [...input.imageIds] }
    } finally {
      if (permit) permits.delete(permit)
      this.busy = false
    }
  }
}
