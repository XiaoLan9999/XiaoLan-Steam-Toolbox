import { setTimeout as delay } from 'node:timers/promises'
import { DomainError } from '../shared/domain'
import type { ScreenshotImportPhase, ScreenshotPrepareInput, ScreenshotPrepareResult } from '../shared/steam-screenshots'
import type { ScreenshotSteamClient, ScreenshotSteamRuntime } from './steam-screenshot-lifecycle-runtime'

export function screenshotImportBlocksChannel(channel: string): boolean {
  if (channel.startsWith('screenshots:')) return !['screenshots:catalog', 'screenshots:images'].includes(channel)
  return ['gameStatus:', 'localAppSimulation:', 'statusCopy:'].some(prefix => channel.startsWith(prefix)) && !channel.endsWith(':state')
}

export class ScreenshotImport {
  private busy = false

  constructor(private readonly options: {
    service: { preflight(input: ScreenshotPrepareInput): Promise<void>; prepare(input: ScreenshotPrepareInput): Promise<ScreenshotPrepareResult> }
    runtime: ScreenshotSteamRuntime
    liveImport?: { prepare(input: ScreenshotPrepareInput): Promise<ScreenshotPrepareResult | null> }
    localImport?: {
      prepareIfInactive(input: ScreenshotPrepareInput): Promise<ScreenshotPrepareResult | null>
      assertCurrentTarget(input: ScreenshotPrepareInput, client?: ScreenshotSteamClient): Promise<void>
    }
    confirmRestart(): Promise<boolean>
    assertRestartAllowed(mode?: 'live' | 'restart'): void
    progress(phase: ScreenshotImportPhase): void
    now?(): number
    sleep?(ms: number): Promise<void>
  }) {}

  async prepare(input: ScreenshotPrepareInput): Promise<ScreenshotPrepareResult | null> {
    if (this.busy) throw new DomainError('SCREENSHOT_BUSY', '截图工具正忙，请稍后重试')
    this.busy = true
    let client: ScreenshotSteamClient | undefined
    let shutdownRequested = false
    let result: ScreenshotPrepareResult | undefined
    let failure: unknown
    let failed = false
    try {
      const mode = input?.mode ?? 'current-account'
      if (mode !== 'current-account' && mode !== 'local-account') throw new DomainError('SCREENSHOT_INVALID_INPUT', '请选择有效的截图导入模式')
      // Validate the destination and queue before interrupting the user's client.
      await this.options.service.preflight(input)
      const steamRunning = await this.options.runtime.isRunning()
      if (mode === 'current-account') {
        if (!steamRunning) throw new DomainError('SCREENSHOT_MODE_ONE_REQUIRES_STEAM', '模式一需要先打开 Steam 并登录目标账号；本地离线导入请选择模式二')
        if ((input.caption ?? '').trim()) throw new DomainError('SCREENSHOT_MODE_ONE_CAPTION_UNSUPPORTED', '模式一暂不支持截图说明，请清空说明或手动选择模式二')
        if (!this.options.localImport) throw new DomainError('SCREENSHOT_ACTIVE_USER_UNAVAILABLE', '无法可靠核验当前 Steam 账号，尚未提交截图')
        if (!this.options.liveImport) throw new DomainError('SCREENSHOT_MODE_ONE_UNAVAILABLE', '当前无法使用模式一；不会自动退出 Steam，请手动选择模式二')
        this.options.assertRestartAllowed('live')
        this.options.progress('connecting-steam')
        await this.options.localImport.assertCurrentTarget(input)
        const live = await this.options.liveImport.prepare({ ...input, preferLive: true })
        if (!live) throw new DomainError('SCREENSHOT_MODE_ONE_UNAVAILABLE', '模式一不可用，尚未提交截图；不会自动切换模式或退出 Steam')
        return live
      }
      if (steamRunning) {
        if (!this.options.localImport) throw new DomainError('SCREENSHOT_ACTIVE_USER_UNAVAILABLE', '无法可靠核验当前 Steam 账号，尚未修改截图索引')
        this.options.progress('importing')
        const inactive = await this.options.localImport.prepareIfInactive(input)
        if (inactive) return inactive
        if (input.restartSteam !== true) throw new DomainError('SCREENSHOT_STEAM_RUNNING', '目标账号正在 Steam 中使用，请先手动完全退出 Steam，或在模式二单独启用自动退出并重启')
        this.options.assertRestartAllowed('restart')
        client = await this.options.runtime.resolveRunningClient(input.steamPath)
        await this.options.localImport.assertCurrentTarget(input, client)
        if (!await this.options.confirmRestart()) return null
        this.options.assertRestartAllowed('restart')
        await this.options.localImport.assertCurrentTarget(input, client)
        this.options.progress('closing-steam')
        try {
          await this.options.runtime.requestShutdown(client)
          shutdownRequested = true
        } catch (error) {
          if (error instanceof DomainError && error.code === 'SCREENSHOT_STEAM_SHUTDOWN_FAILED') {
            // A failed command can still have delivered the asynchronous exit request.
            shutdownRequested = true
            try { await this.waitFor(false, 60_000, 1_500) }
            catch { throw new DomainError('SCREENSHOT_STEAM_SHUTDOWN_UNCONFIRMED', '未确认 Steam 的退出请求是否完成，尚未导入；若客户端随后自行关闭，请手动重新打开 Steam') }
          }
          throw error
        }
        await this.waitFor(false, 60_000, 1_500)
      }
      this.options.progress('importing')
      result = await this.options.service.prepare(input)
    } catch (error) {
      failed = true
      failure = error
    } finally {
      try {
        if (client && shutdownRequested) {
          // Recover the original client even when image conversion/import fails.
          try {
            if (!await this.options.runtime.isRunning()) {
              this.options.progress('starting-steam')
              await this.options.runtime.start(client)
            }
            await this.waitFor(true, 30_000)
            if (result) result.steamRestart = 'restarted'
          } catch {
            if (result) result.steamRestart = 'failed'
            else if (failed) failure = new DomainError('SCREENSHOT_IMPORT_AND_RESTART_FAILED', '截图导入未完成，Steam 也未能重新打开；图片队列已保留，请手动打开 Steam 后重试')
          }
        }
      } finally {
        this.busy = false
        this.options.progress('idle')
      }
    }
    if (failed) throw failure
    return result ?? null
  }

  private async waitFor(running: boolean, timeoutMs: number, stableMs = 0): Promise<void> {
    const now = this.options.now ?? Date.now
    const sleep = this.options.sleep ?? delay
    const deadline = now() + timeoutMs
    let matchedAt: number | null = null
    while (now() <= deadline) {
      if (await this.options.runtime.isRunning() === running) {
        matchedAt ??= now()
        if (now() - matchedAt >= stableMs) return
      } else matchedAt = null
      await sleep(500)
    }
    throw new DomainError(running ? 'SCREENSHOT_STEAM_RESTART_TIMEOUT' : 'SCREENSHOT_STEAM_EXIT_TIMEOUT',
      running ? '未确认 Steam 已重新打开，请手动启动 Steam' : 'Steam 在 60 秒内未完全退出，尚未导入；退出请求可能仍在处理中，若稍后自行关闭，请手动重新打开 Steam')
  }
}
