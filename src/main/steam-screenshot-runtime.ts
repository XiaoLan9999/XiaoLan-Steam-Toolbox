import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { DomainError } from '../shared/domain'
export { findDefaultSteamPaths as discoverScreenshotSteamPaths } from './steam-screenshots'

const execute = promisify(execFile)
interface ScreenshotProcessCheckDependencies {
  platform: NodeJS.Platform
  execute(command: string, args: string[], options: { windowsHide?: boolean; timeout: number; maxBuffer: number; encoding: 'utf8'; shell: false }): Promise<{ stdout: string }>
}

export function hasScreenshotSteamProcesses(output: string, platform: NodeJS.Platform): boolean {
  const text = output.replace(/^\uFEFF/, '')
  if (platform === 'win32') return /^\s*"steam(?:webhelper)?\.exe"\s*,/im.test(text)
  const names = platform === 'darwin' ? 'steam_osx|steamwebhelper' : 'steam|steamwebhelper'
  return new RegExp(`^\\s*[1-9]\\d*\\s+(?:${names})\\s*$`, 'm').test(text)
}

export async function isSteamClientRunning(overrides: Partial<ScreenshotProcessCheckDependencies> = {}): Promise<boolean> {
  const dependencies: ScreenshotProcessCheckDependencies = {
    platform: process.platform,
    execute: async (command, args, options) => {
      const { stdout } = await execute(command, args, options)
      return { stdout }
    },
    ...overrides
  }
  try {
    if (dependencies.platform === 'win32') {
      const { stdout } = await dependencies.execute('tasklist.exe', ['/FI', 'IMAGENAME eq steam*', '/FO', 'CSV', '/NH'], {
        windowsHide: true, timeout: 8_000, maxBuffer: 256 * 1024, encoding: 'utf8', shell: false
      })
      return hasScreenshotSteamProcesses(stdout, dependencies.platform)
    }
    const names = dependencies.platform === 'darwin' ? 'steam_osx|steamwebhelper' : 'steam|steamwebhelper'
    const { stdout } = await dependencies.execute('pgrep', ['-x', '-l', names], { timeout: 5_000, maxBuffer: 256 * 1024, encoding: 'utf8', shell: false })
    return hasScreenshotSteamProcesses(stdout, dependencies.platform)
  } catch (error) {
    if (dependencies.platform !== 'win32' && (error as { code?: number }).code === 1) return false
    throw new DomainError('SCREENSHOT_PROCESS_CHECK_FAILED', '无法检查 Steam 客户端进程，已停止写入；请检查系统权限后重试')
  }
}
