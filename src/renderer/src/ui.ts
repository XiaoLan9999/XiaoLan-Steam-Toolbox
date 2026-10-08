import { IpcResult } from '../../shared/types'

export class UiError extends Error {
  constructor(
    message: string,
    public readonly code = 'UI_ERROR'
  ) {
    super(message)
  }
}

export function unwrap<T>(result: IpcResult<T>): T {
  if (!result.ok) throw new UiError(result.error.message, result.error.code)
  return result.data
}

export function formatDate(value: string | null): string {
  const english = typeof document !== 'undefined' && document.documentElement.lang === 'en'
  if (!value) return english ? 'Not yet' : '尚未'
  return new Intl.DateTimeFormat(english ? 'en-US' : 'zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value))
}

export function formatDuration(milliseconds: number): string {
  const seconds = Math.round(milliseconds / 1000)
  if (typeof document !== 'undefined' && document.documentElement.lang === 'en') {
    return seconds < 60 ? `${seconds} sec` : `${Math.round(seconds / 60)} min`
  }
  return seconds < 60 ? `${seconds} 秒` : `${Math.round(seconds / 60)} 分钟`
}

export function avatarFallback(name: string): string {
  return Array.from(name.trim())[0]?.toUpperCase() ?? '?'
}
