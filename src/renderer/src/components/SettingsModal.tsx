import { useRef, useState } from 'react'
import type { AppSnapshot } from '../../../shared/types'
import { useI18n } from '../i18n'
import { unwrap } from '../ui'
import { applyTheme, normalizeTheme, type Theme } from '../theme'
import { UpdatePanel } from './UpdatePanel'
import type { RunAction } from './types'

export function SettingsModal({ snapshot, onClose, runAction }: {
  snapshot: AppSnapshot; onClose(): void; runAction: RunAction
}): React.JSX.Element {
  const { t } = useI18n()
  const [operation, setOperation] = useState<'export' | 'import' | null>(null)
  const [exportPath, setExportPath] = useState('')
  const [importBackup, setImportBackup] = useState('')
  const [theme, setTheme] = useState<Theme>(() => normalizeTheme(snapshot.theme))
  const [changingTheme, setChangingTheme] = useState(false)
  const transfer = useRef(false)
  const busy = operation !== null || importBackup !== ''
  const exportData = async (): Promise<void> => {
    if (busy || transfer.current) return
    transfer.current = true
    setOperation('export')
    try {
      const result = await runAction(t('正在导出数据', 'Exporting data'), async () => unwrap(await window.steamCommenter.exportData()))
      if (result) setExportPath(result.path)
    } finally { transfer.current = false; setOperation(null) }
  }
  const importData = async (): Promise<void> => {
    if (busy || transfer.current) return
    transfer.current = true
    setOperation('import')
    try {
      const result = await runAction(t('正在校验并准备导入', 'Validating and preparing import'), async () => unwrap(await window.steamCommenter.importData()))
      if (result) setImportBackup(result.backupPath)
    } finally { transfer.current = false; setOperation(null) }
  }
  const changeTheme = async (next: Theme): Promise<void> => {
    if (busy || changingTheme) return
    setChangingTheme(true)
    const previous = theme
    setTheme(next)
    applyTheme(next)
    try {
      const result = await runAction(t('保存主题', 'Saving theme'), async () => { unwrap(await window.steamCommenter.setTheme(next)); return true })
      if (result === null) { setTheme(previous); applyTheme(previous) }
    } finally { setChangingTheme(false) }
  }
  return <div className="modal-backdrop" onMouseDown={() => { if (!busy) onClose() }}>
    <section className="modal settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-heading" onMouseDown={event => event.stopPropagation()}>
      <button className="modal-close" disabled={busy} onClick={onClose} aria-label={t('关闭', 'Close')}>×</button>
      <h2 id="settings-heading">{t('设置', 'Settings')}</h2>
      <div className="settings-appearance-grid">
        <label className="settings-language">
          {t('界面语言', 'Interface language')}
          <select value={snapshot.language} disabled={busy} onChange={event => void runAction(t('切换语言', 'Changing language'),
            async () => unwrap(await window.steamCommenter.setLanguage(event.target.value as 'zh-CN' | 'en')))}>
            <option value="zh-CN">中文</option><option value="en">English (ENG)</option>
          </select>
        </label>
        <label className="settings-theme">
          {t('界面主题', 'Interface theme')}
          <select value={theme} disabled={busy || changingTheme} onChange={event => void changeTheme(normalizeTheme(event.target.value))}>
            <option value="light">{t('浅色', 'Light')}</option><option value="dark">{t('暗夜', 'Dark')}</option>
          </select>
        </label>
      </div>
      <fieldset className="settings-update-controls" disabled={busy}><UpdatePanel state={snapshot.updater} preferences={snapshot.updatePreferences} runAction={runAction} /></fieldset>
      <h3>{t('数据备份与迁移', 'Backup and migration')}</h3>
      <p>{t('导出为完整的 SQLite 数据备份，包含账号资料、分组、黑名单、好友历史、检查任务、草稿和发送记录，不导出密码或自动登录令牌',
        'Exports a complete SQLite backup of accounts, groups, blacklists, friend history, checks, drafts and deliveries, without passwords or login tokens')}</p>
      <div className="settings-transfer-actions">
        <button className="primary" disabled={busy} onClick={() => void exportData()}>{operation === 'export' ? t('正在导出…', 'Exporting…') : t('导出数据', 'Export data')}</button>
        <button disabled={busy} onClick={() => void importData()}>{operation === 'import' ? t('正在校验…', 'Validating…') : t('导入数据', 'Import data')}</button>
      </div>
      <div className="settings-import-notice">
        <strong>{t('导入会整体替换数据库，不合并', 'Import replaces the database; it does not merge')}</strong>
        <p>{t('仅支持工具箱导出的 SQLite 备份。先校验文件，再由你确认；替换前自动备份现有数据，随后重启工具箱，不退出 Steam',
          'Only toolbox SQLite backups are supported. The file is validated before you confirm; existing data is backed up before replacement, then the toolbox restarts without exiting Steam')}</p>
        <p>{t('导入后需重新登录 Steam 账号，未完成任务保持暂停，不会自动发送。本地截图、艺术作品及其它数据库外文件不在导入范围',
          'Sign in to Steam accounts again after import. Unfinished tasks stay paused and never send automatically. Local screenshots, artwork and other files outside the database are not imported')}</p>
      </div>
      {exportPath && <p className="settings-export-path">{t('已导出至：', 'Exported to: ')}<code>{exportPath}</code></p>}
      {importBackup && <p className="settings-import-result" role="status">{t('导入已安排，工具箱即将重启。原数据备份：', 'Import is scheduled and the toolbox will restart. Original-data backup: ')}<code>{importBackup}</code></p>}
      <h3>{t('本机数据目录', 'Local data directory')}</h3>
      <code className="settings-data-path">{snapshot.dataDirectory}</code>
      <button disabled={busy} onClick={() => void runAction(t('打开数据目录', 'Opening data directory'),
        async () => unwrap(await window.steamCommenter.openDataDirectory()))}>{t('打开数据目录', 'Open data directory')}</button>
      <small>{t('备份包含个人数据，请妥善保管。截图导入记录及 Steam 截图文件需单独迁移；不要混用旧的数据库 -wal / -shm 文件',
        'Backups contain personal data; keep them private. Screenshot import records and Steam screenshot files must be migrated separately; do not mix old database -wal / -shm files')}</small>
      <h3>{t('运行诊断', 'Runtime diagnostics')}</h3>
      <p>{t('数据目录中的 diagnostics 文件夹记录工具箱内存、任务数量、界面异常、会话续期和 HTTP 错误分类。日志轮换保存，不含账号、好友、留言正文、URL、Cookie 或登录令牌，也不会上传',
        'The diagnostics folder records toolbox memory, task counts, interface failures, session renewal and HTTP error categories. Rotating logs contain no account, friend, message, URL, cookie or login-token content and are not uploaded')}</p>
    </section>
  </div>
}
