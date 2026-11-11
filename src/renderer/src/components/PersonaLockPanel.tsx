import { useEffect, useRef, useState } from 'react'
import type { AccountView } from '../../../shared/types'
import type { PersonaLockApi, PersonaLockError, PersonaLockSnapshot } from '../../../shared/persona-lock'
import { useI18n, type Translate } from '../i18n'

function errorText(code: PersonaLockError | null, t: Translate): string {
  if (code === 'PERSONA_CONTEXT_CHANGED') return t('本机 Steam 账号或会话已变化，锁定已停止，不会自动连接新账号', 'The local Steam account or session changed; locking stopped without reconnecting to another account')
  if (code === 'PERSONA_PRIVATE_STATE') return t('检测到离线或隐身，已停止锁定并保留该状态', 'Offline or invisible state detected; locking stopped and that state was preserved')
  if (code === 'PERSONA_UNCONFIRMED') return t('本次状态或恢复尚未核实，请在 Steam 中检查；不会标记为已恢复', 'The state or restoration is unconfirmed; check Steam before assuming restoration')
  if (code === 'PERSONA_BUSY') return t('上一项状态操作尚未结束，请稍后重试', 'The previous state operation is still in progress; try again shortly')
  return t('本机状态接口暂不可用，未改用独立账号登录，也不会启动 SteamVR 或大屏幕模式', 'The local status interface is unavailable; no separate login, SteamVR or Big Picture mode is started')
}

export function PersonaLockPanel({ account, api }: { account: AccountView | null; api: PersonaLockApi }): React.JSX.Element {
  const { t, language } = useI18n()
  const [snapshot, setSnapshot] = useState<PersonaLockSnapshot | null>(null)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<PersonaLockError | null>(null)
  const generation = useRef(0)
  useEffect(() => {
    const id = ++generation.current
    setSnapshot(null); setError(null); setWorking(false)
    let received = false
    const unsubscribe = api.onChange(value => { if (id === generation.current) { received = true; setSnapshot(value) } })
    void api.state().then(value => { if (id === generation.current && !received) setSnapshot(value) }, () => { if (id === generation.current && !received) setError('PERSONA_UNAVAILABLE') })
    return () => { generation.current++; unsubscribe() }
  }, [account?.id, api])
  const own = snapshot?.accountId === account?.id
  const locked = own && snapshot?.status === 'locked'
  const busy = working || Boolean(snapshot?.busy)
  const run = async (stop: boolean): Promise<void> => {
    if (!account || !snapshot || busy || !stop && !snapshot.available) return
    const id = generation.current
    setWorking(true); setError(null)
    try {
      const input = { accountId: account.id, sessionId: snapshot.sessionId }
      const state = await (stop ? api.stop(input) : api.start({ ...input, mode: 'snooze' }))
      if (id === generation.current) setSnapshot(state)
    } catch (failure) {
      const code = typeof failure === 'object' && failure !== null && 'code' in failure ? failure.code : null
      if (id === generation.current) setError(['PERSONA_CONTEXT_CHANGED', 'PERSONA_PRIVATE_STATE', 'PERSONA_UNCONFIRMED', 'PERSONA_BUSY'].includes(String(code)) ? code as PersonaLockError : 'PERSONA_UNAVAILABLE')
    } finally { if (id === generation.current) setWorking(false) }
  }
  const shownError = error ?? (own ? snapshot?.error : null)
  const at = own && snapshot?.lastCheckedAt ? Date.parse(snapshot.lastCheckedAt) : NaN
  return <section className="game-status-card" aria-label={t('在线状态锁定', 'Online status lock')}>
    <div className="game-status-section-title"><div><h3>{t('在线状态锁定', 'Online status lock')}</h3>
      <p>{t('玩游戏时维持睡觉 Zzz 标识，游戏名称、子信息和同组人数仍由原来的功能管理', 'Keep the snooze Zzz indicator while playing; game name, substatus and group size remain managed separately')}</p></div></div>
    {snapshot && !snapshot.available && <p className="game-status-notice info">{t('睡觉锁定仍在适配中，本机实测尚未确认生效，暂不开放状态修改', 'Snooze locking is still being adapted; live verification has not confirmed it works, so state changes are currently disabled')}</p>}
    <div className="game-status-notice info"><strong>{locked ? t('睡觉状态已在本机回读匹配', 'Snooze matched on local readback') : t('睡觉 Zzz', 'Snooze Zzz')}</strong>
      <p>{locked ? t('每 5 秒检查一次，仅在状态偏离时重新设置；这不是好友端显示确认', 'Checked every 5 seconds and reapplied only when different; this does not confirm a friend-client display') : t('直接使用当前本机 Steam，不重新登录，不创建假游戏，也不改写游戏富状态', 'Uses the current local Steam session without signing in again, creating a fake game or rewriting game Rich Presence')}</p>
      {Number.isFinite(at) && <p>{t('最近核对', 'Last checked')}: {new Date(at).toLocaleString(language === 'en' ? 'en-US' : 'zh-CN')}</p>}
      {own && snapshot?.restored === true && <p>{t('原在线状态已在本机回读恢复', 'The original online state was restored on local readback')}</p>}
    </div>
    {shownError && <p className="game-status-notice error" role="alert">{errorText(shownError, t)}</p>}
    <div className="game-status-actions">
      <button className="primary" disabled={!account || !snapshot?.available || busy || locked} onClick={() => void run(false)}>{busy ? t('正在处理', 'Working') : t('锁定睡觉状态', 'Lock snooze state')}</button>
      <button className="ghost" disabled={!account || !snapshot || busy || !own || snapshot.status === 'idle'} onClick={() => void run(true)}>{t('解除锁定并恢复', 'Unlock and restore')}</button>
    </div>
    <p className="game-status-help">{t('切换账号或退出工具箱时停止锁定，仅在仍为工具箱设置的睡觉状态时尝试恢复原状态；离线或隐身优先保留，重开工具箱不会自动锁定', 'Account changes or toolbox exit stop locking and attempt restoration only while snooze is still owned by the toolbox; offline or invisible state is preserved and locking never restarts automatically')}</p>
    <p className="game-status-help">{t('VR／Steam Deck 是独立设备标识，目前尚未接入可安全验证的本机修改接口，不会用大屏幕模式或文字冒充', 'VR and Steam Deck are separate device indicators; a verified local setter is not available yet, so neither Big Picture mode nor text is used to imitate them')}</p>
  </section>
}
