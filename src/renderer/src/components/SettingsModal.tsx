import { useState } from 'react'
import type { AppSnapshot } from '../../../shared/types'
import { useI18n } from '../i18n'
import { unwrap } from '../ui'
import { UpdatePanel } from './UpdatePanel'
import type { RunAction } from './types'

export function SettingsModal({ snapshot, onClose, runAction }: {
  snapshot: AppSnapshot; onClose(): void; runAction: RunAction
}): React.JSX.Element {
  const { t } = useI18n()
  const [exporting, setExporting] = useState(false)
  const [exportPath, setExportPath] = useState('')
  const exportData = async (): Promise<void> => {
    setExporting(true)
    try {
      const result = await runAction(t('正在导出数据', 'Exporting data'), async () => unwrap(await window.steamCommenter.exportData()))
      if (result) setExportPath(result.path)
    } finally { setExporting(false) }
  }
  return <div className="modal-backdrop" onMouseDown={() => { if (!exporting) onClose() }}>
    <section className="modal settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-heading" onMouseDown={event => event.stopPropagation()}>
      <button className="modal-close" disabled={exporting} onClick={onClose} aria-label={t('关闭', 'Close')}>×</button>
      <h2 id="settings-heading">{t('设置', 'Settings')}</h2>
      <label className="settings-language">
        {t('界面语言', 'Interface language')}
        <select value={snapshot.language} onChange={event => void runAction(t('切换语言', 'Changing language'),
          async () => unwrap(await window.steamCommenter.setLanguage(event.target.value as 'zh-CN' | 'en')))}>
          <option value="zh-CN">中文</option><option value="en">English (ENG)</option>
        </select>
      </label>
      <UpdatePanel state={snapshot.updater} preferences={snapshot.updatePreferences} runAction={runAction} />
      <h3>{t('数据备份与迁移', 'Backup and migration')}</h3>
      <p>{t('导出为完整的 SQLite 数据备份，包含账号资料、分组、黑名单、解除好友和昵称变化记录、检查任务、草稿和发送记录。不导出密码或自动登录令牌。',
        'Exports a complete SQLite backup of account profiles, groups, blacklists, friendship removal and name change history, checks, drafts and delivery history. Passwords and login tokens are not exported.')}</p>
      <button className="primary" disabled={exporting} onClick={() => void exportData()}>
        {exporting ? t('正在导出…', 'Exporting…') : t('导出数据', 'Export data')}
      </button>
      {exportPath && <p className="settings-export-path">{t('已导出至：', 'Exported to: ')}<code>{exportPath}</code></p>}
      <h3>{t('本机数据目录', 'Local data directory')}</h3>
      <code className="settings-data-path">{snapshot.dataDirectory}</code>
      <button onClick={() => void runAction(t('打开数据目录', 'Opening data directory'),
        async () => unwrap(await window.steamCommenter.openDataDirectory()))}>{t('打开数据目录', 'Open data directory')}</button>
      <ol>
        <li>{t('新电脑安装同版或更新版软件，打开数据目录，然后退出软件。', 'On the new computer, run the same or a newer version, open its data directory, then close the app.')}</li>
        <li>{t('先备份新电脑的整个数据目录，再将导出文件复制到一个空的数据目录，重命名为 steam-friend-commenter.sqlite3。不要混用旧的 -wal / -shm 文件。',
          'Back up the entire destination data directory first. Put the exported file in an empty data directory and rename it to steam-friend-commenter.sqlite3. Do not mix it with old -wal / -shm files.')}</li>
        <li>{t('启动后重新登录原 Steam 账号，分组和黑名单保留，未完成任务需手动继续。此操作整体替换数据，不合并。',
          'Reopen and sign in to the original Steam accounts. Groups and blacklists remain; unfinished tasks resume only on request. This replaces data, not merges it.')}</li>
      </ol>
      <small>{t('备份包含个人数据，请妥善保管。留言与检查最低间隔均为 0.1 秒；Steam 限流时仍会暂停。',
        'Backups contain personal data; keep them private. Comments and checks both support 0.1-second minimum intervals. Steam rate limits still pause tasks.')}</small>
      <h3>{t('运行诊断', 'Runtime diagnostics')}</h3>
      <p>{t('数据目录中的 diagnostics 文件夹每分钟记录工具箱自身的内存用量和任务数量，并记录界面异常退出、会话续期结果和 HTTP 错误分类。日志轮换保存两份，每份最多 1 MiB；不包含账号、好友、留言正文、URL、Cookie 或登录令牌，不会上传。',
        'The diagnostics folder records toolbox memory and task counts every minute, plus interface exits, session renewal outcomes and HTTP error classifications. Two rotating files are kept, up to 1 MiB each. No account, friend, message, URL, cookie or login-token content is recorded or uploaded.')}</p>
    </section>
  </div>
}
