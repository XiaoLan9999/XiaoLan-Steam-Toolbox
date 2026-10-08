import { useMemo, useState } from 'react'
import type { FriendRemovalRecord } from '../../../shared/types'
import { useI18n } from '../i18n'
import { avatarFallback } from '../ui'

type RemovalFilter = 'unrestored' | 'all'

interface FriendRemovalsPanelProps {
  removals: FriendRemovalRecord[]
  canSync: boolean
  onSync(): void
}

export function filterFriendRemovals(removals: FriendRemovalRecord[], search: string, filter: RemovalFilter): FriendRemovalRecord[] {
  const query = search.trim().toLocaleLowerCase()
  return removals.filter((removal) =>
    (filter === 'all' || removal.restoredAt === null) &&
    (!query || removal.displayName.toLocaleLowerCase().includes(query) || removal.steamId.includes(query))
  )
}

export function FriendRemovalsPanel({ removals, canSync, onSync }: FriendRemovalsPanelProps): React.JSX.Element {
  const { t, language } = useI18n()
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<RemovalFilter>('unrestored')
  const visible = useMemo(() => filterFriendRemovals(removals, search, filter), [filter, removals, search])
  const dateFormatter = useMemo(() => new Intl.DateTimeFormat(language === 'en' ? 'en-US' : 'zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }), [language])
  const formatDate = (value: string): string => dateFormatter.format(new Date(value))
  const removedCount = removals.filter((removal) => removal.restoredAt === null).length

  return <div className="friend-removals-panel">
    <div className="friend-toolbar">
      <label className="search-box"><span>⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t('搜索已解除好友的昵称或 SteamID', 'Search removed friends by name or SteamID')} aria-label={t('搜索已解除好友', 'Search removed friends')} /></label>
      <label className="comment-filter">{t('记录范围', 'History filter')}<select value={filter} onChange={(event) => setFilter(event.target.value as RemovalFilter)}><option value="unrestored">{t('仍未恢复', 'Still removed')}</option><option value="all">{t('全部历史（含重新加回）', 'All history (including re-added)')}</option></select></label>
      <button className="ghost" disabled={!canSync} onClick={onSync}>↻ {t('同步好友', 'Sync friends')}</button>
    </div>
    <div className="friend-removals-note">
      <strong>{t(`仍未恢复 ${removedCount} 人 · 历史 ${removals.length} 条 · 当前显示 ${visible.length} 条`, `${removedCount} still removed · ${removals.length} historical records · ${visible.length} shown`)}</strong>
      <p>{t('通过成功同步前后的好友列表对比发现关系变化，无法判断是对方删除你，还是你删除对方。发现时间不是实际解除时间；昵称和头像是最后保存的缓存。', 'Changes are detected by comparing friends lists after a successful sync. This cannot tell who removed whom. The detection time is not the exact removal time; names and avatars are cached details.')}</p>
      <p>{t('重新加回会保留历史并标记恢复；再次解除会新增记录。此页仅供查看，不可勾选留言、分组或启动留言权限检查。', 'Re-adding a friend marks the record restored without deleting its history. A later removal creates a new record. This page is read-only: no comment selection, grouping or availability checks.')}</p>
    </div>
    {removals.length === 0 ? <div className="empty-state"><div>◎</div><h3>{t('暂无解除好友记录', 'No removed-friend records')}</h3><p>{t('之后成功同步时，已不在好友列表中的缓存好友会显示在这里。未曾缓存的历史好友无法追溯。', 'After a successful sync, cached friends missing from the latest list appear here. Friends never cached by this app cannot be recovered from past history.')}</p></div> : <div className="friend-removals-table-wrap">
      <table className="friend-removals-table"><thead><tr><th>{t('好友（缓存）', 'Friend (cached)')}</th><th>SteamID</th><th>{t('发现时间', 'Detected at')}</th><th>{t('关系状态', 'Relationship status')}</th><th><span className="removal-profile-label">{t('资料页', 'Profile')}</span></th></tr></thead><tbody>
        {visible.map((removal) => <tr key={removal.id}>
          <td><div className="friend-identity">{removal.avatarUrl ? <img src={removal.avatarUrl} alt="" loading="lazy" referrerPolicy="no-referrer" draggable={false} /> : <span>{avatarFallback(removal.displayName)}</span>}<div className="friend-name"><strong title={removal.displayName}>{removal.displayName}</strong></div></div></td>
          <td><code>{removal.steamId}</code></td>
          <td>{removal.detectedAt ? <time dateTime={removal.detectedAt}>{formatDate(removal.detectedAt)}</time> : <span className="removal-legacy-time">{t('旧版缓存 · 时间未知', 'Legacy cache · Time unknown')}</span>}</td>
          <td><div className="removal-relationship"><span className={`removal-status ${removal.restoredAt === null ? 'removed' : 'restored'}`}>{removal.restoredAt === null ? t('已解除', 'Removed') : t('重新加回', 'Re-added')}</span>{removal.restoredAt && <time dateTime={removal.restoredAt}>{t('恢复发现于', 'Re-addition detected')} {formatDate(removal.restoredAt)}</time>}</div></td>
          <td><a href={removal.profileUrl} target="_blank" rel="noreferrer" title={t('打开 Steam 资料页', 'Open Steam profile')} aria-label={t(`打开 ${removal.displayName} 的 Steam 资料页`, `Open Steam profile for ${removal.displayName}`)}>↗</a></td>
        </tr>)}
      </tbody></table>
      {visible.length === 0 && <div className="no-results">{filter === 'unrestored' && !search.trim() ? t('目前没有仍未恢复的好友，可切换“全部历史”查看重新加回的记录。', 'No friends remain removed. Switch to All history to view re-added records.') : t('没有符合筛选条件的解除记录', 'No removal records match these filters')}</div>}
    </div>}
  </div>
}
