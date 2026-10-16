import { useRef, useState } from 'react'
import type { AccountView } from '../../../shared/types'
import { localizeMessage } from '../../../shared/localization'
import { useI18n } from '../i18n'
import { unwrap } from '../ui'
import type { RunAction } from './types'
import './account-status.css'

export function AccountStatusPanel({ account, runAction }: { account: AccountView; runAction: RunAction }): React.JSX.Element {
  const { language, t } = useI18n()
  const [checking, setChecking] = useState(false)
  const lock = useRef(false)
  const check = async (): Promise<void> => {
    if (lock.current) return
    lock.current = true
    setChecking(true)
    try {
      await runAction(t('正在核验账号状态', 'Checking account status'), async () =>
        unwrap(await window.steamCommenter.refreshAccountStatus(account.id)))
    } finally { lock.current = false; setChecking(false) }
  }
  const state = checking ? 'checking' : account.statusCheckState
  const time = account.statusCheckedAt ? Date.parse(account.statusCheckedAt) : NaN
  return <section className="account-status-check" aria-label={t('账号状态检查', 'Account status check')}>
    <div><strong>{t('当前账号状态', 'Current account status')}</strong>
      <button className="ghost" disabled={checking || state === 'checking'} onClick={() => void check()}>
        {state === 'checking' ? t('检查中…', 'Checking…') : t('刷新检查', 'Refresh status')}
      </button></div>
    <span className={state === 'verified' ? 'status-verified' : 'status-unverified'}>
      {state === 'checking' ? t('正在核验 Steam 网页登录身份', 'Verifying Steam web identity')
        : state === 'verified' ? t('网页登录身份已核验', 'Web sign-in verified')
          : state === 'unverified' ? t('本次未能核验，请查看原因', 'Could not verify; see the reason')
            : t('点击检查，不发送留言', 'Check without sending a comment')}
    </span>
    {account.statusCheckMessage && <small>{localizeMessage(account.statusCheckMessage, language)}</small>}
    {Number.isFinite(time) && <time dateTime={account.statusCheckedAt!}>{new Date(time).toLocaleString(language === 'en' ? 'en-US' : 'zh-CN')}</time>}
  </section>
}
