import { useMemo, useState } from 'react'
import type { FriendNameChangeRecord } from '../../../shared/types'
import { useI18n } from '../i18n'
import { avatarFallback } from '../ui'

interface FriendNameChangesPanelProps {
  accountId: string
  changes: FriendNameChangeRecord[]
  canSync: boolean
  onSync(): void
}

export function filterFriendNameChanges(changes: FriendNameChangeRecord[], accountId: string, search: string): FriendNameChangeRecord[] {
  const query = search.trim().toLocaleLowerCase()
  return changes.filter((change) => change.accountId === accountId &&
    (!query || change.oldName.toLocaleLowerCase().includes(query) || change.newName.toLocaleLowerCase().includes(query) || change.steamId.includes(query)))
}

export function FriendNameChangesPanel({ accountId, changes, canSync, onSync }: FriendNameChangesPanelProps): React.JSX.Element {
  const { t, language } = useI18n()
  const [search, setSearch] = useState('')
  const accountChanges = useMemo(() => filterFriendNameChanges(changes, accountId, ''), [accountId, changes])
  const visible = useMemo(() => filterFriendNameChanges(accountChanges, accountId, search), [accountChanges, accountId, search])
  const dateFormatter = useMemo(() => new Intl.DateTimeFormat(language === 'en' ? 'en-US' : 'zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }), [language])

  return <div className="friend-name-changes-panel">
    <div className="friend-toolbar">
      <label className="search-box"><span>⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t('搜索旧昵称、新昵称或 SteamID', 'Search old name, new name or SteamID')} aria-label={t('搜索昵称变化', 'Search name changes')} /></label>
      <button className="ghost" disabled={!canSync} onClick={onSync}>↻ {t('同步好友', 'Sync friends')}</button>
    </div>
    <div className="friend-name-changes-note">
      <strong>{t(`昵称变化 ${accountChanges.length} 条 · 当前显示 ${visible.length} 条`, `${accountChanges.length} name changes · ${visible.length} shown`)}</strong>
      <p>{t('成功同步获得新昵称后，与已保存的昵称比较并记录变化。发现时间不是精确改名时间；首次获取资料不算更名，使用缓存也不会新增记录。', 'A successful sync compares newly fetched names with saved names. The detection time is not the exact rename time. First-time profiles and cached names do not create name-change records.')}</p>
      <p>{t('每个账号独立保存，同一好友多次改名会保留多条历史，也会包含在导出数据中。此页仅供查看，不可勾选留言、分组或启动留言权限检查。', 'History is saved per account. Repeated name changes stay as separate records and are included in data exports. This page is read-only: no comment selection, grouping or availability checks.')}</p>
    </div>
    {accountChanges.length === 0 ? <div className="empty-state"><div>◎</div><h3>{t('暂无昵称变化记录', 'No name-change records')}</h3><p>{t('之后同步发现好友昵称变化时，会显示旧昵称、新昵称和发现时间。软件首次记录之前的改名无法追溯。', 'Future syncs that detect a changed name show the old name, new name and detection time. Changes before the app first saved a name cannot be recovered.')}</p></div> : <div className="friend-name-changes-table-wrap">
      <table className="friend-name-changes-table"><thead><tr><th>{t('昵称变化', 'Name change')}</th><th>SteamID</th><th>{t('发现时间', 'Detected at')}</th><th>{t('资料页', 'Profile')}</th></tr></thead><tbody>
        {visible.map((change) => <tr key={change.id}>
          <td><div className="friend-identity">{change.avatarUrl ? <img src={change.avatarUrl} alt="" loading="lazy" referrerPolicy="no-referrer" draggable={false} /> : <span>{avatarFallback(change.newName)}</span>}<div className="friend-name-change"><span className="friend-old-name" title={change.oldName}>{change.oldName}</span><span className="friend-name-change-arrow" aria-label={t('改为', 'Changed to')}>→</span><strong className="friend-new-name" title={change.newName}>{change.newName}</strong></div></div></td>
          <td><code>{change.steamId}</code></td>
          <td><time dateTime={change.detectedAt}>{dateFormatter.format(new Date(change.detectedAt))}</time></td>
          <td><a href={change.profileUrl} target="_blank" rel="noreferrer" title={t('打开 Steam 资料页', 'Open Steam profile')} aria-label={t(`打开 ${change.newName} 的 Steam 资料页`, `Open Steam profile for ${change.newName}`)}>↗</a></td>
        </tr>)}
      </tbody></table>
      {visible.length === 0 && <div className="no-results">{t('没有符合搜索条件的昵称变化记录', 'No name-change records match this search')}</div>}
    </div>}
  </div>
}
