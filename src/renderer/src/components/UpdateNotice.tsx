import { useEffect, useState } from 'react'
import type { UpdateState } from '../../../shared/update-types'
import { useI18n } from '../i18n'
import { DISMISSED_UPDATE_VERSION_KEY, dismissUpdateVersion, readDismissedUpdateVersion, shouldShowUpdateNotice } from '../update-notification'
import './update-notice.css'

export interface UpdateNoticeModel {
  key: string
  kind: 'available' | 'ready'
  version: string
}

export function updateNoticeForState(state: UpdateState, dismissedThrough: string | null = null): UpdateNoticeModel | null {
  if (!shouldShowUpdateNotice(state, dismissedThrough)) return null
  return { key: `version:${state.latestVersion}`, kind: state.phase === 'ready' ? 'ready' : 'available', version: state.latestVersion! }
}

export function UpdateNotice({ state, onOpenSettings }: { state: UpdateState; onOpenSettings(): void }): React.JSX.Element | null {
  const { t } = useI18n()
  const [dismissed, setDismissed] = useState(readDismissedUpdateVersion)
  useEffect(() => {
    const sync = (event: StorageEvent): void => {
      if (event.key === null || event.key === DISMISSED_UPDATE_VERSION_KEY) setDismissed(readDismissedUpdateVersion())
    }
    window.addEventListener('storage', sync)
    return () => window.removeEventListener('storage', sync)
  }, [])
  const notice = updateNoticeForState(state, dismissed)
  if (!notice) return null
  return <section className={`update-notice update-notice-${notice.kind}`} role="status" aria-live="polite"
    aria-label={t('软件更新提醒', 'Software update notification')}>
    <div className="update-notice-copy">
      <strong>{notice.kind === 'ready' ? t(`新版 v${notice.version} 已就绪`, `Update v${notice.version} is ready`)
          : t(`发现新版本 v${notice.version}`, `Update v${notice.version} is available`)}</strong>
      <p>{notice.kind === 'ready' ? t('已下载并校验；保存工作后在设置中确认重启', 'Downloaded and verified. Save your work, then confirm the restart in Settings')
          : t(`当前 v${state.currentVersion}；在设置中下载，不会自动安装`, `Current v${state.currentVersion}. Download in Settings; installation is never automatic`)}</p>
      <button className="ghost" onClick={onOpenSettings}>{t('查看更新', 'View update')}</button>
    </div>
    <button className="update-notice-close" aria-label={t('不再提醒此版本', 'Do not remind me about this version')}
      onClick={() => setDismissed(dismissUpdateVersion(notice.version))}>&times;</button>
  </section>
}
