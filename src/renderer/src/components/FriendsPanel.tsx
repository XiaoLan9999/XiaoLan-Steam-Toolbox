import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { AppSnapshot, CommentEligibility, FriendGroup, FriendPolicy, FriendRecord } from '../../../shared/types'
import { invertFriendSelection } from '../friend-selection'
import { useFriendSelection } from '../use-friend-selection'
import { useI18n } from '../i18n'
import { avatarFallback, formatDate, unwrap } from '../ui'
import { RunAction } from './types'
import { FriendRemovalsPanel } from './FriendRemovalsPanel'
import { FriendNameChangesPanel } from './FriendNameChangesPanel'
import './friends-management.css'

interface FriendsPanelProps {
  snapshot: AppSnapshot
  selected: Set<string>
  onSelectedChange(value: Set<string>): void
  onCompose(): void
  runAction: RunAction
}

const eligibilityLabels: Record<CommentEligibility, [string, string]> = {
  unchecked: ['尚未检查', 'Not checked'],
  allowed: ['页面可留言', 'Comments available'],
  blocked: ['页面不可留言', 'Comments unavailable'],
  unknown: ['暂无法判断', 'Unknown']
}

export function FriendsPanel({ snapshot, selected, onSelectedChange, onCompose, runAction }: FriendsPanelProps): React.JSX.Element {
  const { t } = useI18n()
  const [search, setSearch] = useState('')
  const [groupFilter, setGroupFilter] = useState('all')
  const [listView, setListView] = useState<'normal' | 'blacklist' | 'removed' | 'nameChanges'>('normal')
  const [statusFilter, setStatusFilter] = useState<CommentEligibility | 'all'>('all')
  const [newGroupName, setNewGroupName] = useState('')
  const [newGroupColor, setNewGroupColor] = useState('#66c0f4')
  const [assignment, setAssignment] = useState('')
  const [renamingGroup, setRenamingGroup] = useState<FriendGroup | null>(null)
  const [renamedValue, setRenamedValue] = useState('')
  const [scanDelay, setScanDelay] = useState(10)
  const [scanSubmitting, setScanSubmitting] = useState(false)
  const account = snapshot.accounts.find((item) => item.id === snapshot.activeAccountId)!
  const accountIdRef = useRef(account.id)
  accountIdRef.current = account.id
  const headerCheckbox = useRef<HTMLInputElement>(null)
  const policies = useMemo(() => new Map(snapshot.friendPolicies.map((policy) => [policy.steamId, policy])), [snapshot.friendPolicies])
  const blacklistedCount = useMemo(() => snapshot.friends.filter((friend) => policies.get(friend.steamId)?.blacklisted).length, [policies, snapshot.friends])
  const friendRemovals = useMemo(() => snapshot.friendRemovals.filter((removal) => removal.accountId === account.id), [account.id, snapshot.friendRemovals])
  const removedCount = friendRemovals.filter((removal) => removal.restoredAt === null).length
  const friendNameChanges = useMemo(() => snapshot.friendNameChanges.filter((change) => change.accountId === account.id), [account.id, snapshot.friendNameChanges])
  const readOnlyView = listView === 'removed' || listView === 'nameChanges'
  const groupCounts = useMemo(() => {
    const counts = new Map<string, number>([['all', snapshot.friends.length], ['ungrouped', 0]])
    for (const friend of snapshot.friends) {
      if (!friend.groupIds.length) counts.set('ungrouped', counts.get('ungrouped')! + 1)
      for (const id of friend.groupIds) counts.set(id, (counts.get(id) ?? 0) + 1)
    }
    return counts
  }, [snapshot.friends])

  useEffect(() => {
    setSearch('')
    setGroupFilter('all')
    setListView('normal')
    setStatusFilter('all')
    setAssignment('')
    setNewGroupName('')
    setRenamingGroup(null)
    setScanDelay(10)
    setScanSubmitting(false)
  }, [account.id])

  useEffect(() => {
    const known = new Set(snapshot.friends.map((friend) => friend.steamId))
    const next = new Set([...selected].filter((steamId) => known.has(steamId)))
    if (next.size !== selected.size) onSelectedChange(next)
  }, [onSelectedChange, selected, snapshot.friends])

  useEffect(() => {
    if (groupFilter !== 'all' && groupFilter !== 'ungrouped' && !snapshot.groups.some((group) => group.id === groupFilter)) {
      setGroupFilter('all')
    }
  }, [groupFilter, snapshot.groups])

  const visibleFriends = useMemo(() => {
    if (listView === 'removed' || listView === 'nameChanges') return []
    const query = search.trim().toLocaleLowerCase()
    return snapshot.friends.filter((friend) => {
      const policy = policies.get(friend.steamId)
      const matchesList = listView === 'blacklist' ? policy?.blacklisted === true : !policy?.blacklisted
      const matchesStatus = statusFilter === 'all' || (policy?.commentStatus ?? 'unchecked') === statusFilter
      const matchesQuery = !query || friend.displayName.toLocaleLowerCase().includes(query) || friend.steamId.includes(query)
      const matchesGroup = groupFilter === 'all' || (groupFilter === 'ungrouped' ? friend.groupIds.length === 0 : friend.groupIds.includes(groupFilter))
      return matchesList && matchesStatus && matchesQuery && matchesGroup
    })
  }, [groupFilter, listView, policies, search, snapshot.friends, statusFilter])
  const visibleIds = useMemo(() => visibleFriends.map((friend) => friend.steamId), [visibleFriends])
  const selection = useFriendSelection(account.id, visibleIds, selected, onSelectedChange)
  const selectedVisibleCount = visibleIds.filter((id) => selected.has(id)).length
  const allVisibleSelected = visibleIds.length > 0 && selectedVisibleCount === visibleIds.length
  const selectedAllowedIds = [...selected].filter((id) => !policies.get(id)?.blacklisted)
  const selectedBlacklistedCount = selected.size - selectedAllowedIds.length
  const scan = snapshot.commentScan
  const scanActive = scan?.status === 'running' || scan?.status === 'paused'
  const scanBusy = scanActive || scanSubmitting
  const canScan = account.sessionState === 'authenticated' && !scanBusy
  const safeScanDelay = Math.min(60, Math.max(5, Number.isFinite(scanDelay) ? scanDelay : 10))
  const currentScanFriend = scan?.currentSteamId ? snapshot.friends.find((friend) => friend.steamId === scan.currentSteamId) : null

  useEffect(() => {
    if (headerCheckbox.current) headerCheckbox.current.indeterminate = selectedVisibleCount > 0 && !allVisibleSelected
  }, [allVisibleSelected, selectedVisibleCount])

  const selectVisible = (): void => onSelectedChange(new Set([...selected, ...visibleIds]))
  const toggleVisible = (): void => {
    const next = new Set(selected)
    visibleIds.forEach((id) => allVisibleSelected ? next.delete(id) : next.add(id))
    onSelectedChange(next)
  }
  const switchView = (view: 'normal' | 'blacklist' | 'removed' | 'nameChanges'): void => {
    if (view === listView) return
    selection.stopDrag()
    setListView(view)
    onSelectedChange(new Set())
  }
  const createGroup = async (): Promise<void> => {
    const name = newGroupName.trim()
    if (!name) return
    const id = account.id
    const result = await runAction(t('正在创建分组', 'Creating group'), async () => unwrap(await window.steamCommenter.createGroup(id, name, newGroupColor)), t('分组已创建', 'Group created'))
    if (result && accountIdRef.current === id) setNewGroupName('')
  }
  const assignSelected = async (): Promise<void> => {
    if (selected.size === 0) return
    await runAction(t('正在更新分组', 'Updating groups'), async () => unwrap(await window.steamCommenter.setFriendGroups(account.id, [...selected], assignment ? [assignment] : [])), assignment ? t('好友已移动到分组', 'Friends moved to group') : t('好友已设为未分组', 'Friends are now ungrouped'))
  }
  const renameGroup = async (): Promise<void> => {
    const name = renamedValue.trim()
    const group = renamingGroup
    if (!group || !name) return
    const result = await runAction(t('正在重命名', 'Renaming group'), async () => unwrap(await window.steamCommenter.renameGroup(group.accountId, group.id, name)))
    if (result !== null && accountIdRef.current === group.accountId) setRenamingGroup(null)
  }
  const deleteGroup = async (group: FriendGroup): Promise<void> => {
    if (!window.confirm(t(`删除分组“${group.name}”？好友不会从 Steam 删除。`, `Delete group "${group.name}"? Friends will not be removed from Steam.`))) return
    await runAction(t('正在删除分组', 'Deleting group'), async () => unwrap(await window.steamCommenter.deleteGroup(account.id, group.id)), t('分组已删除', 'Group deleted'))
  }
  const updateBlacklist = async (blacklisted: boolean): Promise<void> => {
    const ids = [...selected].filter((id) => Boolean(policies.get(id)?.blacklisted) !== blacklisted)
    if (!ids.length) return
    const accountId = account.id
    const result = await runAction(blacklisted ? t('正在加入黑名单', 'Adding to blacklist') : t('正在移出黑名单', 'Removing from blacklist'), async () => unwrap(await window.steamCommenter.setBlacklist(accountId, ids, blacklisted)), t(`${ids.length} 位好友已${blacklisted ? '加入' : '移出'}黑名单`, `${ids.length} friends ${blacklisted ? 'added to' : 'removed from'} the blacklist`))
    if (result !== null && accountIdRef.current === accountId) onSelectedChange(new Set())
  }
  const startScan = async (ids: string[]): Promise<void> => {
    if (!ids.length || !canScan) return
    const accountId = account.id
    setScanSubmitting(true)
    try {
      await runAction(t('正在创建留言权限检查任务', 'Starting comment availability check'), async () => unwrap(await window.steamCommenter.startCommentScan({ accountId, friendSteamIds: ids, delayMs: safeScanDelay * 1000 })), t('检查任务已启动，可继续筛选、分组或切换页面', 'Check started. You can keep filtering, grouping or switching pages.'))
    } finally {
      if (accountIdRef.current === accountId) setScanSubmitting(false)
    }
  }
  const selectedGroup = snapshot.groups.find((group) => group.id === groupFilter)
  const scanMinutes = Math.ceil(Math.max(0, visibleIds.length - 1) * safeScanDelay / 60)

  return (
    <div className="panel-stack friend-management">
      <section className="stats-row">
        <article><span>{t('好友总数', 'Total friends')}</span><strong>{snapshot.friends.length}</strong><small>{t('同步于', 'Synced')} {formatDate(account.lastFriendSyncAt)}</small></article>
        <article><span>{t('当前选中', 'Selected')}</span><strong>{selected.size}</strong><small>{t(`筛选内 ${selectedVisibleCount} 人 · 切换账号自动清空`, `${selectedVisibleCount} in this filter · Cleared on account switch`)}</small></article>
        <article><span>{t('黑名单', 'Blacklist')}</span><strong>{blacklistedCount}</strong><small>{t('本账号不发送留言的好友', 'Excluded from comments for this account')}</small></article>
      </section>

      {!readOnlyView && <section className="card group-card">
        <div className="card-heading">
          <div><h2>{t('好友分组', 'Friend groups')}</h2><p>{t('每个账号独立保存，同一好友不会跨账号串组。', 'Groups are saved independently for each account.')}</p></div>
          <div className="new-group">
            <input value={newGroupName} maxLength={40} onChange={(event) => setNewGroupName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void createGroup() }} placeholder={t('新分组名称', 'New group name')} />
            <input className="color-input" type="color" value={newGroupColor} onChange={(event) => setNewGroupColor(event.target.value)} aria-label={t('分组颜色', 'Group color')} />
            <button onClick={() => void createGroup()}>{t('创建', 'Create')}</button>
          </div>
        </div>
        <div className="group-pills">
          <GroupPill label={t('全部分组', 'All groups')} count={snapshot.friends.length} active={groupFilter === 'all'} onClick={() => setGroupFilter('all')} />
          <GroupPill label={t('未分组', 'Ungrouped')} count={groupCounts.get('ungrouped') ?? 0} active={groupFilter === 'ungrouped'} onClick={() => setGroupFilter('ungrouped')} />
          {snapshot.groups.map((group) => <GroupPill key={group.id} label={group.name} count={groupCounts.get(group.id) ?? 0} color={group.color} active={groupFilter === group.id} onClick={() => setGroupFilter(group.id)} />)}
          {selectedGroup && <span className="group-actions"><button onClick={() => { setRenamingGroup(selectedGroup); setRenamedValue(selectedGroup.name) }}>{t('重命名', 'Rename')}</button><button className="danger-text" onClick={() => void deleteGroup(selectedGroup)}>{t('删除', 'Delete')}</button></span>}
        </div>
        {renamingGroup && <div className="group-rename-inline"><label>{t(`重命名“${renamingGroup.name}”`, `Rename "${renamingGroup.name}"`)}<input autoFocus maxLength={40} value={renamedValue} onChange={(event) => setRenamedValue(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void renameGroup(); if (event.key === 'Escape') setRenamingGroup(null) }} /></label><button className="ghost" onClick={() => void renameGroup()}>{t('保存', 'Save')}</button><button className="ghost" onClick={() => setRenamingGroup(null)}>{t('取消', 'Cancel')}</button></div>}
      </section>}

      {!readOnlyView && <section className="card comment-scan-card" aria-label={t('留言权限检查任务', 'Comment availability check')}>
        <div className="card-heading"><div><h2>{t('留言权限检查', 'Comment availability check')}</h2><p>{t('按顺序读取好友资料页，不会测试发送留言。页面可留言不代表一定投递成功；无法判断不会自动拉黑。', 'Reads profile pages one at a time, without posting test comments. An available form does not guarantee delivery. Unknown results are never automatically blacklisted.')}</p></div><span className="scan-readonly-badge">{t('只读检查', 'Read only')}</span></div>
        <div className="comment-scan-controls">
          <label>{t('检查间隔', 'Interval')}<input type="number" min={5} max={60} step={1} value={scanDelay} disabled={scanBusy} onChange={(event) => setScanDelay(Number(event.target.value))} onBlur={() => setScanDelay(safeScanDelay)} />{t('秒 / 人', 'sec / friend')}</label>
          <button className="ghost" disabled={!canScan || visibleIds.length === 0} onClick={() => void startScan(visibleIds)}>{t(`检查当前筛选 · ${visibleIds.length} 人`, `Check filtered · ${visibleIds.length}`)}</button>
          <button className="ghost" disabled={!canScan || selected.size === 0} onClick={() => void startScan([...selected])}>{t(`检查已选 · ${selected.size} 人`, `Check selected · ${selected.size}`)}</button>
          <small>{t(`5–60 秒；当前筛选至少约 ${scanMinutes} 分钟`, `5–60 sec; filtered list takes at least ~${scanMinutes} min`)}</small>
        </div>
        {scan && <div className="comment-scan-progress" aria-live="polite">
          <div className="scan-progress-heading"><strong>{t(...scanStatusLabels[scan.status])} · {scan.completed} / {scan.total}</strong><div className="scan-actions">
            {scan.status === 'running' && <button className="ghost" onClick={() => void runAction(t('正在暂停检查', 'Pausing check'), async () => unwrap(await window.steamCommenter.pauseCommentScan(scan.id)))}>{t('暂停', 'Pause')}</button>}
            {scan.status === 'paused' && <button className="ghost" disabled={account.sessionState !== 'authenticated'} onClick={() => void runAction(t('正在继续检查', 'Resuming check'), async () => unwrap(await window.steamCommenter.resumeCommentScan(scan.id)))}>{t('继续', 'Resume')}</button>}
            {scanActive && <button className="ghost danger-text" onClick={() => void runAction(t('正在取消检查', 'Cancelling check'), async () => unwrap(await window.steamCommenter.cancelCommentScan(scan.id)))}>{t('取消任务', 'Cancel task')}</button>}
          </div></div>
          <progress max={scan.total || 1} value={scan.completed} aria-label={t('留言权限检查进度', 'Comment check progress')} />
          <div className="scan-counts"><span className="comment-status allowed">{t('可留言', 'Available')} {scan.allowed}</span><span className="comment-status blocked">{t('不可留言', 'Unavailable')} {scan.blocked}</span><span className="comment-status unknown">{t('无法判断', 'Unknown')} {scan.unknown}</span><small>{scan.currentSteamId ? t(`正在检查：${currentScanFriend?.displayName ?? scan.currentSteamId}`, `Checking: ${currentScanFriend?.displayName ?? scan.currentSteamId}`) : t(`每人间隔 ${scan.delayMs / 1000} 秒`, `${scan.delayMs / 1000} seconds per friend`)}</small></div>
          {scan.lastError && <p className="scan-error">{scan.lastError}</p>}
          {scanActive && <small className="scan-background-note">{t('任务在后台运行，可以继续操作。暂停或取消不会撤销已完成的检查。', 'Runs in the background. Pausing or cancelling keeps completed results.')}</small>}
        </div>}
        <p className="scan-help">{t('检查后可筛选“页面不可留言” → 全选筛选结果 → 加入黑名单。检查结果和黑名单仅属于当前账号。', 'After checking: filter Comments unavailable → Select filtered → Add to blacklist. Results and the blacklist belong only to this account.')}</p>
      </section>}

      <section className="card friends-card">
        <div className="friend-view-tabs" role="tablist" aria-label={t('好友名单', 'Friend lists')}>
          <button role="tab" aria-selected={listView === 'normal'} className={listView === 'normal' ? 'active' : ''} onClick={() => switchView('normal')}>{t('正常好友', 'Regular friends')} <b>{snapshot.friends.length - blacklistedCount}</b></button>
          <button role="tab" aria-selected={listView === 'blacklist'} className={listView === 'blacklist' ? 'active' : ''} onClick={() => switchView('blacklist')}>{t('黑名单', 'Blacklist')} <b>{blacklistedCount}</b></button>
          <button role="tab" aria-selected={listView === 'removed'} className={listView === 'removed' ? 'active' : ''} onClick={() => switchView('removed')}>{t('已解除好友', 'Removed friends')} <b>{removedCount}</b></button>
          <button role="tab" aria-selected={listView === 'nameChanges'} className={listView === 'nameChanges' ? 'active' : ''} onClick={() => switchView('nameChanges')}>{t('昵称变化', 'Name changes')} <b>{friendNameChanges.length}</b></button>
          <span>{listView === 'nameChanges' ? t('仅展示本账号发现的昵称变化，不可选择发送留言。', 'Read-only name changes detected by this account. Not selectable for comments.') : listView === 'removed' ? t('仅展示关系变化记录，不计入当前好友数，也不能选择发送留言。', 'Read-only relationship history. Not counted as current friends or selectable for comments.') : listView === 'blacklist' ? t('黑名单不删除 Steam 好友，也不改变分组；移出后才能发送留言。', 'Does not unfriend or change groups. Remove from blacklist to send comments.') : t('默认排除黑名单好友，避免误选发送。', 'Blacklisted friends are excluded by default.')}</span>
        </div>
        {listView === 'nameChanges' ? <FriendNameChangesPanel key={account.id} accountId={account.id} changes={friendNameChanges} canSync={account.sessionState === 'authenticated'} onSync={() => void runAction(t('正在同步好友资料', 'Syncing friend profiles'), async () => unwrap(await window.steamCommenter.syncFriends(account.id)))} /> : listView === 'removed' ? <FriendRemovalsPanel key={account.id} removals={friendRemovals} canSync={account.sessionState === 'authenticated'} onSync={() => void runAction(t('正在同步好友资料', 'Syncing friend profiles'), async () => unwrap(await window.steamCommenter.syncFriends(account.id)))} /> : <><div className="friend-toolbar">
          <label className="search-box"><span>⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t('搜索昵称或 SteamID', 'Search name or SteamID')} /></label>
          <label className="comment-filter">{t('留言状态', 'Comment status')}<select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as CommentEligibility | 'all')}><option value="all">{t('全部检查状态', 'All check results')}</option>{Object.entries(eligibilityLabels).map(([value, labels]) => <option key={value} value={value}>{t(...labels)}</option>)}</select></label>
          <button className="ghost" disabled={account.sessionState !== 'authenticated'} onClick={() => void runAction(t('正在同步好友资料', 'Syncing friend profiles'), async () => unwrap(await window.steamCommenter.syncFriends(account.id)))}>↻ {t('同步好友', 'Sync friends')}</button>
        </div>
        <div className="friend-bulk-toolbar">
          <span>{t('筛选结果', 'Filtered')} <strong>{visibleIds.length}</strong> · {t('已选', 'Selected')} <strong>{selected.size}</strong></span>
          <button className="ghost" disabled={visibleIds.length === 0 || allVisibleSelected} onClick={selectVisible}>{t('全选筛选结果', 'Select filtered')}</button>
          <button className="ghost" disabled={visibleIds.length === 0} onClick={() => onSelectedChange(invertFriendSelection(visibleIds, selected))}>{t('反选筛选结果', 'Invert filtered')}</button>
          <button className="ghost" disabled={selected.size === 0} onClick={() => onSelectedChange(new Set())}>{t('清空选择', 'Clear selection')}</button>
        </div>
        <div className="friend-selection-help">{t('单击好友行或复选框只切换该好友，不影响其他已选项。按住并拖动可叠加选择范围，保留此前已选好友；靠近列表上下边缘可自动滚动。Ctrl / ⌘ 从已选行开始拖动可减选，Shift 点击或拖动连续加选。', 'Click a row or checkbox to toggle only that friend, keeping other selections. Drag adds a range and keeps previously selected friends; hold near the list edges to auto-scroll. Ctrl / ⌘ drag from a selected row removes a range. Shift click or drag adds a range.')}</div>
        <div className="selection-tools friend-selected-tools">
          <select disabled={selected.size === 0} aria-label={t('批量设置分组', 'Assign selected friends to group')} value={assignment} onChange={(event) => setAssignment(event.target.value)}><option value="">{t('未分组', 'Ungrouped')}</option>{snapshot.groups.map((group) => <option value={group.id} key={group.id}>{group.name}</option>)}</select>
          <button disabled={selected.size === 0} onClick={() => void assignSelected()}>{t(`应用分组 · ${selected.size} 人`, `Apply group · ${selected.size}`)}</button>
          {listView === 'normal' ? <button className="danger-text" disabled={selectedAllowedIds.length === 0} onClick={() => void updateBlacklist(true)}>{t(`加入黑名单 · ${selectedAllowedIds.length} 人`, `Add to blacklist · ${selectedAllowedIds.length}`)}</button> : <button disabled={selectedBlacklistedCount === 0} onClick={() => void updateBlacklist(false)}>{t(`移出黑名单 · ${selectedBlacklistedCount} 人`, `Remove from blacklist · ${selectedBlacklistedCount}`)}</button>}
          <button className="primary" disabled={selectedAllowedIds.length === 0} onClick={() => { onSelectedChange(new Set(selectedAllowedIds)); onCompose() }}>{t(`去留言 · ${selectedAllowedIds.length} 人 →`, `Compose · ${selectedAllowedIds.length} →`)}</button>
        </div>
        {snapshot.friends.length === 0 ? <div className="empty-state"><div>◎</div><h3>{t('还没有好友缓存', 'No cached friends yet')}</h3><p>{t('登录成功后会自动同步，也可以点击上方“同步好友”。', 'Friends sync after login. You can also click Sync friends above.')}</p></div> : <div className={`friend-table-wrap friend-drag-surface ${selection.dragging ? 'is-dragging' : ''}`} ref={selection.containerRef} onPointerDown={selection.beginDrag} onPointerMove={selection.moveDrag} onPointerUp={selection.finishDrag} onPointerCancel={selection.stopDrag} onLostPointerCapture={selection.stopDrag}>
          <table className="friend-table"><thead><tr><th><input ref={headerCheckbox} type="checkbox" checked={allVisibleSelected} onChange={toggleVisible} aria-label={t('选择或取消当前筛选的所有好友', 'Toggle all filtered friends')} /></th><th>{t('好友', 'Friend')}</th><th>{t('在线状态', 'Presence')}</th><th>{t('留言检查', 'Comment check')}</th><th>{t('本地分组', 'Local groups')}</th><th>SteamID</th><th /></tr></thead><tbody>
            {visibleFriends.map((friend) => <FriendRow key={friend.steamId} friend={friend} groups={snapshot.groups} policy={policies.get(friend.steamId)} selected={selected.has(friend.steamId)} onToggle={selection.toggle} />)}
          </tbody></table>
          {visibleFriends.length === 0 && <div className="no-results">{listView === 'blacklist' && blacklistedCount === 0 ? t('黑名单为空。选中正常好友后，可批量加入黑名单。', 'Blacklist is empty. Select regular friends to add them in bulk.') : t('没有符合筛选条件的好友', 'No friends match these filters')}</div>}
        </div>}</>}
      </section>
    </div>
  )
}

function GroupPill({ label, count, color, active, onClick }: { label: string; count: number; color?: string; active: boolean; onClick(): void }): React.JSX.Element {
  return <button className={`group-pill ${active ? 'active' : ''}`} onClick={onClick}>{color && <i style={{ backgroundColor: color }} />}{label}<b>{count}</b></button>
}

const FriendRow = memo(function FriendRow({ friend, groups, policy, selected, onToggle }: { friend: FriendRecord; groups: FriendGroup[]; policy?: FriendPolicy; selected: boolean; onToggle(id: string, shift?: boolean): void }): React.JSX.Element {
  const { t } = useI18n()
  const friendGroups = groups.filter((group) => friend.groupIds.includes(group.id))
  const status = policy?.commentStatus ?? 'unchecked'
  return <tr className={`${selected ? 'selected' : ''} ${policy?.blacklisted ? 'is-blacklisted' : ''}`} data-friend-id={friend.steamId} aria-selected={selected}>
    <td><input type="checkbox" checked={selected} readOnly onClick={(event) => onToggle(friend.steamId, event.shiftKey)} onKeyDown={(event) => { if (event.key === ' ' && event.shiftKey) { event.preventDefault(); onToggle(friend.steamId, true) } }} aria-label={t(`选择 ${friend.displayName}`, `Select ${friend.displayName}`)} /></td>
    <td><div className="friend-identity">{friend.avatarUrl ? <img src={friend.avatarUrl} alt="" loading="lazy" referrerPolicy="no-referrer" draggable={false} /> : <span>{avatarFallback(friend.displayName)}</span>}<div className="friend-name"><strong title={friend.displayName}>{friend.displayName}</strong>{policy?.blacklisted && <small className="blacklist-badge">{t('黑名单 · 不发送', 'Blacklisted · No comments')}</small>}</div></div></td>
    <td><span className={`presence ${friend.onlineState}`}>{t(...presenceLabels[friend.onlineState])}</span></td>
    <td><div className="friend-comment-check"><span className={`comment-status ${status}`}>{t(...eligibilityLabels[status])}</span>{policy?.commentReason && <small className="check-reason" title={policy.commentReason}>{policy.commentReason}</small>}{policy?.commentCheckedAt && <time dateTime={policy.commentCheckedAt} title={t(`检查于 ${formatDate(policy.commentCheckedAt)}`, `Checked ${formatDate(policy.commentCheckedAt)}`)}>{formatDate(policy.commentCheckedAt)}</time>}</div></td>
    <td><div className="mini-groups">{friendGroups.length ? friendGroups.map((group) => <span key={group.id}><i style={{ backgroundColor: group.color }} /> {group.name}</span>) : <em>{t('未分组', 'Ungrouped')}</em>}</div></td>
    <td><code>{friend.steamId}</code></td>
    <td><a href={friend.profileUrl} target="_blank" rel="noreferrer" title={t('打开 Steam 资料页', 'Open Steam profile')} aria-label={t(`打开 ${friend.displayName} 的 Steam 资料页`, `Open Steam profile for ${friend.displayName}`)}>↗</a></td>
  </tr>
})

const presenceLabels: Record<FriendRecord['onlineState'], [string, string]> = {
  'in-game': ['游戏中', 'In game'], online: ['在线', 'Online'], offline: ['离线', 'Offline'], unknown: ['未知', 'Unknown']
}
const scanStatusLabels: Record<NonNullable<AppSnapshot['commentScan']>['status'], [string, string]> = {
  running: ['正在检查', 'Checking'], paused: ['检查已暂停', 'Paused'], completed: ['检查已完成', 'Completed'], cancelled: ['检查已取消', 'Cancelled']
}
