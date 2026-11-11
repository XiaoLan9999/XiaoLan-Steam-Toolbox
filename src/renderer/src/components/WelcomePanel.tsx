import type { AppSnapshot } from '../../../shared/types'
import type { ReactNode } from 'react'
import { useI18n } from '../i18n'
import './welcome-panel.css'

export type WelcomeDestination = 'friends' | 'history' | 'tools' | 'screenshots' | 'game-status' | 'steam-accounts' | 'authenticator'

export function WelcomePanel({ snapshot, onNavigate, onLogin, onSettings, connectionNotice }: {
  snapshot: AppSnapshot
  onNavigate(destination: WelcomeDestination): void
  onLogin(): void
  onSettings(): void
  connectionNotice?: ReactNode
}): React.JSX.Element {
  const { t } = useI18n()
  const account = snapshot.accounts.find(item => item.id === snapshot.activeAccountId)
  const batch = snapshot.activeBatch?.accountId === account?.id ? snapshot.activeBatch : null
  const cards: Array<{ destination: WelcomeDestination; mark: string; title: string; description: string; label: string }> = [
    { destination: 'friends', mark: '01', title: t('好友留言板', 'Friend comments'),
      description: t('好友与分组、批量留言、黑名单和持久任务，在独立模块里处理', 'Manage friends, groups, comments, blacklist and durable tasks in one dedicated module'),
      label: t('打开留言板', 'Open comments') },
    { destination: 'game-status', mark: '02', title: t('游戏状态与自定义', 'Game status & presence'),
      description: t('读取游戏图标与支持的子状态，编辑实际游玩信息或维护所选状态', 'Read game icons and supported presence templates, edit live fields or maintain selected values'),
      label: t('打开游戏状态', 'Open game status') },
    { destination: 'tools', mark: '03', title: t('艺术作品与背景', 'Artwork & backgrounds'),
      description: t('在工具箱中选择背景、裁剪主图与侧图，准备艺术作品', 'Choose backgrounds and crop main and side artwork inside the toolbox'),
      label: t('打开艺术作品工具', 'Open artwork tools') },
    { destination: 'screenshots', mark: '04', title: t('Steam 截图工具', 'Steam screenshots'),
      description: t('选择用户与游戏，准备本地图片，再从 Steam 客户端上传', 'Choose a user and game, prepare local images, then upload through the Steam client'),
      label: t('打开截图工具', 'Open screenshots') },
    { destination: 'steam-accounts', mark: '05', title: t('Steam 账号切换', 'Steam account switcher'),
      description: t('选择 Steam 客户端已记住的账号，确认后正常退出并重新打开，不切换工具箱账号', 'Choose an account remembered by Steam and confirm a normal restart, independently of the toolbox account'),
      label: t('打开账号切换', 'Open account switcher') },
    { destination: 'authenticator', mark: '06', title: t('本地手机令牌', 'Local authenticators'),
      description: t('手动导入已有 maFile，在本机加密保存并查看小号 Steam Guard 验证码', 'Import existing maFiles and view Steam Guard codes for your other accounts with encrypted local storage'),
      label: t('打开手机令牌', 'Open authenticators') }
  ]
  return <section className="toolbox-home" aria-label={t('工具箱欢迎', 'Toolbox welcome')}>
    <header className="toolbox-home-hero">
      <div className="toolbox-home-kicker">LOCAL PROJECT <span>/</span> XIAOLAN STEAM TOOLBOX</div>
      <div className="toolbox-home-context">
        <span>{t(`${snapshot.accounts.length} 个已保存账号`, `${snapshot.accounts.length} saved accounts`)}</span>
        <span>{account ? t(`当前账号：${account.displayName}`, `Selected: ${account.displayName}`) : t('尚未选择账号', 'No account selected')}</span>
        <button className="ghost" onClick={onLogin}>{t('添加账号', 'Add account')}</button>
      </div>
    </header>
    {connectionNotice}
    {batch && <section className="toolbox-home-task" aria-label={t('当前留言任务', 'Current comment task')}>
      <div><strong>{batch.status === 'running' ? t('留言任务正在进行', 'Comment task in progress')
        : batch.status === 'paused' ? t('有一项暂停的留言任务', 'A comment task is paused') : t('有一项待处理留言任务', 'A comment task is pending')}</strong>
        <p>{t(`已确认 ${batch.sentVerified} · 待核对 ${batch.uncertain} · 待发 ${batch.pending}`,
          `Confirmed ${batch.sentVerified} · Uncertain ${batch.uncertain} · Pending ${batch.pending}`)}</p></div>
      <button onClick={() => onNavigate('history')}>{t('查看原任务', 'View existing task')}</button>
    </section>}
    <div className="toolbox-home-grid">{cards.map(card => <article className="toolbox-home-card" key={card.destination}>
      <span className="toolbox-home-card-mark" aria-hidden="true">{card.mark}</span>
      <h2>{card.title}</h2><p>{card.description}</p>
      <button className="ghost" onClick={() => onNavigate(card.destination)}>{card.label}<span aria-hidden="true"> &gt;</span></button>
    </article>)}</div>
    <footer className="toolbox-home-footer"><button className="ghost" onClick={onSettings}>{t('设置、主题与数据迁移', 'Settings, theme & data transfer')}</button></footer>
  </section>
}
