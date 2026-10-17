import { useState } from 'react'
import type { UpdateState } from '../../../shared/update-types'
import { useI18n } from '../i18n'
import './update-notice.css'

export interface UpdateNoticeModel {
  key: string
  kind: 'available' | 'ready' | 'error'
  version: string | null
}

function newerStableVersion(latest: string | null, current: string): boolean {
  const parse = (value: string | null): number[] | null => {
    if (!value || value.length > 64 || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) return null
    const parts = value.split('.').map(Number)
    return parts.every(Number.isSafeInteger) ? parts : null
  }
  const left = parse(latest)
  const right = parse(current)
  if (!left || !right) return false
  for (let index = 0; index < 3; index += 1) {
    if (left[index]! !== right[index]!) return left[index]! > right[index]!
  }
  return false
}

export function updateNoticeForState(state: UpdateState, dismissed: ReadonlySet<string> = new Set()): UpdateNoticeModel | null {
  let notice: UpdateNoticeModel
  if ((state.phase === 'available' || state.phase === 'ready') && newerStableVersion(state.latestVersion, state.currentVersion)) {
    notice = { key: `version:${state.latestVersion}`, kind: state.phase, version: state.latestVersion }
  } else if (state.phase === 'error' && state.error !== 'update.cancelled') {
    notice = { key: `error:${state.error ?? 'unknown'}`, kind: 'error', version: null }
  } else return null
  return dismissed.has(notice.key) ? null : notice
}

export function UpdateNotice({ state, onOpenSettings }: { state: UpdateState; onOpenSettings(): void }): React.JSX.Element | null {
  const { t } = useI18n()
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set())
  const notice = updateNoticeForState(state, dismissed)
  if (!notice) return null
  const isError = notice.kind === 'error'
  return <section className={`update-notice update-notice-${notice.kind}`} role="status" aria-live="polite"
    aria-label={t('软件更新提醒', 'Software update notification')}>
    <div className="update-notice-copy">
      <strong>{isError ? t('软件更新遇到问题', 'Software update needs attention')
        : notice.kind === 'ready' ? t(`新版 v${notice.version} 已就绪`, `Update v${notice.version} is ready`)
          : t(`发现新版本 v${notice.version}`, `Update v${notice.version} is available`)}</strong>
      <p>{isError ? t('请到设置中查看线路并重试。不会中断当前任务。', 'Review update routes and retry in Settings. Current tasks are not interrupted.')
        : notice.kind === 'ready' ? t('已下载并校验；保存工作后在设置中确认重启。', 'Downloaded and verified. Save your work, then confirm the restart in Settings.')
          : t(`当前 v${state.currentVersion}；在设置中下载，不会自动安装。`, `Current v${state.currentVersion}. Download in Settings; installation is never automatic.`)}</p>
      <button className="ghost" onClick={onOpenSettings}>{isError ? t('到设置重试', 'Retry in Settings') : t('查看更新', 'View update')}</button>
    </div>
    <button className="update-notice-close" aria-label={isError ? t('关闭本次错误提醒', 'Dismiss this update error') : t('关闭本次版本提醒', 'Dismiss this update version')}
      onClick={() => setDismissed(current => new Set([...current, notice.key]))}>&times;</button>
  </section>
}
