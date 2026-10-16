import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { DomainError } from '../shared/domain'
export { findDefaultSteamPaths as discoverScreenshotSteamPaths } from './steam-screenshots'

const execute = promisify(execFile)
export async function isSteamClientRunning(): Promise<boolean> {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execute('tasklist.exe', ['/FI', 'IMAGENAME eq steam.exe', '/FO', 'CSV', '/NH'], {
        windowsHide: true, timeout: 8_000, maxBuffer: 256 * 1024
      })
      return /"steam\.exe"/i.test(stdout)
    }
    const { stdout } = await execute('pgrep', ['-x', process.platform === 'darwin' ? 'steam_osx' : 'steam'], { timeout: 5_000 })
    return stdout.trim().length > 0
  } catch (error) {
    if (process.platform !== 'win32' && (error as { code?: number }).code === 1) return false
    throw new DomainError('SCREENSHOT_PROCESS_CHECK_FAILED', '无法检查 Steam 客户端进程，已停止写入；请检查系统权限后重试')
  }
}
