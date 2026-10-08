import { useEffect, useMemo, useRef, useState } from 'react'
import {
  MAX_BATCH_RECIPIENTS,
  MAX_COMMENT_LENGTH,
  MAX_DELAY_MS,
  MIN_DELAY_MS,
  countCharacters
} from '../../../shared/domain'
import { composerIssues, type ComposerIssue } from '../../../shared/composer-validation'
import { AppSnapshot, BatchRecord, SteamEmoticon } from '../../../shared/types'
import { avatarFallback, formatDuration, unwrap } from '../ui'
import { useI18n, type Translate } from '../i18n'
import { RunAction } from './types'

interface ComposerPanelProps {
  snapshot: AppSnapshot
  selected: Set<string>
  onSelectedChange(value: Set<string>): void
  onOpenFriends(): void
  runAction: RunAction
}

export function ComposerPanel({
  snapshot,
  selected,
  onSelectedChange,
  onOpenFriends,
  runAction
}: ComposerPanelProps): React.JSX.Element {
  const { language, t } = useI18n()
  const account = snapshot.accounts.find((item) => item.id === snapshot.activeAccountId)!
  const [draft, setDraft] = useState(snapshot.settings?.draft ?? '')
  const [delaySeconds, setDelaySeconds] = useState((snapshot.settings?.delayMs ?? 15_000) / 1000)
  const [emoticonOpen, setEmoticonOpen] = useState(false)
  const [emoticonSearch, setEmoticonSearch] = useState('')
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submissionError, setSubmissionError] = useState('')
  const [saveError, setSaveError] = useState('')
  const submissionLock = useRef(false)
  const hydratedAccount = useRef(account.id)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (hydratedAccount.current === account.id) return
    hydratedAccount.current = account.id
    setDraft(snapshot.settings?.draft ?? '')
    setDelaySeconds((snapshot.settings?.delayMs ?? 15_000) / 1000)
    setConfirmOpen(false)
    setConfirmed(false)
    setSubmissionError('')
    setSaveError('')
  }, [account.id, snapshot.settings])

  useEffect(() => {
    let cancelled = false
    const timer = window.setTimeout(() => {
      if (!Number.isFinite(delaySeconds) || delaySeconds < MIN_DELAY_MS / 1000 || delaySeconds > MAX_DELAY_MS / 1000) return
      void window.steamCommenter.updateSettings(account.id, draft, delaySeconds * 1000)
        .then((result) => { if (!cancelled) setSaveError(result.ok ? '' : result.error.message) })
        .catch((error: unknown) => { if (!cancelled) setSaveError(error instanceof Error ? error.message : String(error)) })
    }, 600)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [account.id, delaySeconds, draft])

  const blacklistedIds = useMemo(() => new Set(snapshot.friendPolicies
    .filter((policy) => policy.blacklisted).map((policy) => policy.steamId)), [snapshot.friendPolicies])
  const eligibleFriends = useMemo(() => snapshot.friends
    .filter((friend) => !blacklistedIds.has(friend.steamId)), [snapshot.friends, blacklistedIds])
  const selectedRecords = useMemo(
    () => eligibleFriends.filter((friend) => selected.has(friend.steamId)),
    [selected, eligibleFriends]
  )
  const excludedCount = [...selected].filter((id) => blacklistedIds.has(id)).length
  const filteredEmoticons = useMemo(() => {
    const query = emoticonSearch.trim().toLocaleLowerCase()
    return snapshot.emoticons.filter(
      (emoticon) => !query || emoticon.name.toLocaleLowerCase().includes(query)
    )
  }, [emoticonSearch, snapshot.emoticons])
  const normalizedDraft = draft.replace(/\r\n/g, '\n').trim()
  const characterCount = countCharacters(normalizedDraft)
  const renderedPreview = selectedRecords[0]
    ? normalizedDraft
        .replaceAll('{friend}', selectedRecords[0].displayName)
        .replaceAll('{account}', account.displayName)
    : normalizedDraft
  const issues = composerIssues({
    authenticated: account.sessionState === 'authenticated',
    recipients: selectedRecords,
    excludedCount,
    message: draft,
    accountName: account.displayName,
    delayMs: delaySeconds * 1000,
    hasActiveBatch: Boolean(snapshot.activeBatch)
  })
  const canStart = issues.length === 0 && !submitting
  const lastBatch = snapshot.activeBatch ?? snapshot.batches[0]
  const closeConfirmation = (): void => {
    if (submissionLock.current) return
    setConfirmOpen(false)
    setConfirmed(false)
  }

  const insertEmoticon = (emoticon: SteamEmoticon): void => {
    const textarea = textareaRef.current
    if (!textarea) {
      setDraft((current) => `${current}${emoticon.token}`)
      return
    }
    const start = textarea.selectionStart
    const end = textarea.selectionEnd
    const next = `${draft.slice(0, start)}${emoticon.token}${draft.slice(end)}`
    setDraft(next)
    window.requestAnimationFrame(() => {
      const cursor = start + emoticon.token.length
      textarea.focus()
      textarea.setSelectionRange(cursor, cursor)
    })
  }

  const selectGroup = (groupId: string): void => {
    const friendIds = eligibleFriends
      .filter((friend) => groupId === 'all' || friend.groupIds.includes(groupId))
      .map((friend) => friend.steamId)
    onSelectedChange(new Set(friendIds))
  }

  const startBatch = async (): Promise<void> => {
    if (submissionLock.current || !confirmed || !canStart) return
    submissionLock.current = true
    setSubmitting(true)
    setSubmissionError('')
    try {
      const batch = await runAction(t('正在创建发送批次', 'Creating delivery batch'), async () => {
        try {
          return unwrap(await window.steamCommenter.startBatch({
            accountId: account.id,
            friendSteamIds: selectedRecords.map((friend) => friend.steamId),
            messageTemplate: draft,
            delayMs: delaySeconds * 1000
          }))
        } catch (error) {
          setSubmissionError(error instanceof Error ? error.message : String(error))
          throw error
        }
      })
      if (batch) {
        setConfirmOpen(false)
        setConfirmed(false)
        onSelectedChange(new Set())
      }
    } catch (error) {
      setSubmissionError(error instanceof Error ? error.message : String(error))
    } finally {
      submissionLock.current = false
      setSubmitting(false)
    }
  }

  return (
    <div className="composer-layout">
      <div className="composer-main panel-stack">
        <section className="card recipients-card">
          <div className="card-heading">
            <div>
              <h2>{t('1. 选择留言对象', '1. Select recipients')}</h2>
              <p>{t('只允许选择当前账号已同步的 Steam 好友，黑名单好友始终排除。', 'Choose synced friends of this account. Blacklisted friends are always excluded.')}</p>
            </div>
            <button className="ghost" onClick={onOpenFriends}>
              {t('管理好友选择', 'Manage selection')}
            </button>
          </div>
          <div className="quick-groups">
            <button onClick={() => selectGroup('all')}>{t('非黑名单好友', 'Non-blacklisted friends')} ({eligibleFriends.length})</button>
            {snapshot.groups.map((group) => (
              <button key={group.id} onClick={() => selectGroup(group.id)}>
                <i style={{ backgroundColor: group.color }} />
                {group.name} (
                {eligibleFriends.filter((friend) => friend.groupIds.includes(group.id)).length})
              </button>
            ))}
            <button className="clear" onClick={() => onSelectedChange(new Set())}>
              {t('清空', 'Clear')}
            </button>
          </div>
          <div className="recipient-strip">
            {selectedRecords.length ? (
              selectedRecords.slice(0, 12).map((friend) => (
                <span key={friend.steamId}>
                  {friend.avatarUrl ? (
                    <img src={friend.avatarUrl} alt="" referrerPolicy="no-referrer" />
                  ) : (
                    <i>{avatarFallback(friend.displayName)}</i>
                  )}
                  {friend.displayName}
                  <button
                    onClick={() => {
                      const next = new Set(selected)
                      next.delete(friend.steamId)
                      onSelectedChange(next)
                    }}
                  >
                    ×
                  </button>
                </span>
              ))
            ) : (
              <em>{t('尚未选择好友', 'No friends selected')}</em>
            )}
            {selectedRecords.length > 12 && <b>{t(`另有 ${selectedRecords.length - 12} 人`, `${selectedRecords.length - 12} more`)}</b>}
          </div>
          {excludedCount > 0 && <div className="inline-warning">{t(`已排除 ${excludedCount} 位黑名单好友，不会发送留言。`, `${excludedCount} blacklisted friends excluded. No comments will be sent to them.`)}</div>}
          {selectedRecords.length > MAX_BATCH_RECIPIENTS && (
            <div className="inline-warning">
              {t(`单次最多 ${MAX_BATCH_RECIPIENTS} 人；当前选择 ${selectedRecords.length} 人，请拆分批次。`, `A batch allows ${MAX_BATCH_RECIPIENTS} recipients; ${selectedRecords.length} are selected. Split the selection into batches.`)}
              {' '}<button onClick={() => onSelectedChange(new Set(selectedRecords.slice(0, MAX_BATCH_RECIPIENTS).map((friend) => friend.steamId)))}>
                {t(`仅保留前 ${MAX_BATCH_RECIPIENTS} 位`, `Keep first ${MAX_BATCH_RECIPIENTS} only`)}
              </button>
            </div>
          )}
        </section>

        <section className="card message-card">
          <div className="card-heading">
            <div>
              <h2>{t('2. 编写资料页留言', '2. Write profile comments')}</h2>
              <p>
                {t('好友昵称：', 'Friend name: ')}<code>{'{friend}'}</code>{t('，当前账号昵称：', '; account name: ')}<code>{'{account}'}</code>{t('。', '.')}
              </p>
            </div>
          </div>
          <div className="editor-shell">
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={t('例如：你好 {friend}，周末愉快！', 'Example: Hello {friend}, have a nice weekend!')}
              rows={8}
            />
            <div className="editor-toolbar">
              <button
                className={emoticonOpen ? 'active' : ''}
                onClick={() => setEmoticonOpen((current) => !current)}
              >
                ☺ {t('Steam 表情', 'Steam emoticons')}
                <b>{snapshot.emoticons.length}</b>
              </button>
              <span className={characterCount > MAX_COMMENT_LENGTH ? 'over-limit' : ''}>
                {characterCount} / {MAX_COMMENT_LENGTH}
              </span>
            </div>
          </div>
          {emoticonOpen && (
            <div className="emoticon-picker">
              <div>
                <input
                  value={emoticonSearch}
                  onChange={(event) => setEmoticonSearch(event.target.value)}
                  placeholder={t('搜索当前账号拥有的表情', 'Search emoticons owned by this account')}
                />
                <button
                  className="ghost"
                  disabled={account.sessionState !== 'authenticated'}
                  onClick={() =>
                    void runAction(
                      t('正在同步 Steam 表情', 'Syncing Steam emoticons'),
                      async () => unwrap(await window.steamCommenter.syncEmoticons(account.id)),
                      t('表情列表已同步', 'Emoticons synced')
                    )
                  }
                >
                  ↻ {t('刷新', 'Refresh')}
                </button>
              </div>
              <section>
                {filteredEmoticons.map((emoticon) => (
                  <button
                    key={emoticon.token}
                    title={emoticon.token}
                    onClick={() => insertEmoticon(emoticon)}
                  >
                    <img src={emoticon.imageUrl} alt={emoticon.token} loading="lazy" />
                    <span>{emoticon.name}</span>
                  </button>
                ))}
                {filteredEmoticons.length === 0 && (
                  <p>{snapshot.emoticons.length ? t('没有匹配的表情', 'No matching emoticons') : t('当前账号尚未同步到可用表情', 'No emoticons synced for this account yet')}</p>
                )}
              </section>
            </div>
          )}
        </section>

        <section className="card delivery-card">
          <div className="card-heading">
            <div>
              <h2>{t('3. 发送设置', '3. Delivery settings')}</h2>
              <p>{t('逐条单线程发送，并在基础间隔上增加 0–3 秒随机抖动。', 'Send sequentially, with 0–3 seconds of random jitter added to the base interval.')}</p>
            </div>
          </div>
          <div className="delivery-settings">
            <label>
              {t('基础间隔', 'Base interval')}
              <span>
                <input
                  type="number"
                  min={1}
                  max={300}
                  step={1}
                  value={delaySeconds}
                  onChange={(event) => setDelaySeconds(Number(event.target.value))}
                />
                {t('秒', 'seconds')}
              </span>
            </label>
            <div>
              <small>{t('预计最短耗时', 'Estimated minimum time')}</small>
              <strong>{formatDeliveryDuration(Math.max(0, selectedRecords.length - 1) * Math.max(0, delaySeconds) * 1000, language)}</strong>
            </div>
            <button className="primary send-button" disabled={!canStart} aria-describedby="send-readiness" onClick={() => { setConfirmed(false); setSubmissionError(''); setConfirmOpen(true) }}>
              {t('预览并确认发送', 'Preview and confirm')}
            </button>
          </div>
          <div id="send-readiness" aria-live="polite">
            {issues.length > 0 && <div className="inline-warning"><strong>{t('暂时不能发送：', 'Cannot send yet:')}</strong><ul>
              {issues.map((issue) => <li key={issue.code}>{issueText(issue, t)}</li>)}
            </ul></div>}
            {saveError && <div className="inline-warning">{t('草稿保存失败：', 'Draft could not be saved: ')}{saveError}</div>}
          </div>
        </section>
      </div>

      <aside className="composer-aside">
        <section className="card preview-card">
          <span className="eyebrow">STEAM PREVIEW</span>
          <h3>{t('首位好友留言预览', 'Preview for the first friend')}</h3>
          <div className="steam-comment-preview">
            <div className="preview-author">
              {account.avatarUrl ? (
                <img src={account.avatarUrl} alt="" referrerPolicy="no-referrer" />
              ) : (
                <i>{avatarFallback(account.displayName)}</i>
              )}
              <span>
                <strong>{account.displayName}</strong>
                <small>{t('刚刚', 'Just now')}</small>
              </span>
            </div>
            <p>{renderedPreview || t('留言预览会显示在这里。', 'Your comment preview will appear here.')}</p>
          </div>
          <small>{t('Steam 的最终字体和表情渲染可能与此预览不同。', 'Steam may render fonts and emoticons differently.')}</small>
        </section>

        {lastBatch && (
          <ActiveBatchPanel batch={lastBatch} runAction={runAction} />
        )}

        <section className="card boundary-card">
          <h3>{t('发送边界', 'Delivery rules')}</h3>
          <ul>
            <li>{t('仅当前登录账号、当前好友快照', 'Current account and synced friends only')}</li>
            <li>{t('黑名单始终排除；发送前会再次检查', 'Blacklist checked again before every send')}</li>
            <li>{t('批次创建后冻结收件人与最终文本', 'Recipients and final text are frozen when created')}</li>
            <li>{t('网络结果不确定时不会自动重发', 'Uncertain deliveries are never retried automatically')}</li>
            <li>{t('重启后未完成批次默认保持暂停', 'Unfinished batches stay paused after restarting')}</li>
          </ul>
        </section>
      </aside>

      {confirmOpen && (
        <div className="modal-backdrop" onMouseDown={closeConfirmation}>
          <div className="modal confirm-modal" onMouseDown={(event) => event.stopPropagation()}>
            <button className="modal-close" disabled={submitting} onClick={closeConfirmation}>
              ×
            </button>
            <p className="eyebrow">FINAL CONFIRMATION</p>
            <h2>{t('确认资料页公开留言', 'Confirm public profile comments')}</h2>
            <dl className="confirm-facts">
              <div>
                <dt>{t('发送账号', 'Sending account')}</dt>
                <dd>{account.displayName}</dd>
              </div>
              <div>
                <dt>{t('好友人数', 'Recipients')}</dt>
                <dd>{selectedRecords.length}</dd>
              </div>
              <div>
                <dt>{t('基础间隔', 'Base interval')}</dt>
                <dd>{delaySeconds} {t('秒', 'seconds')}</dd>
              </div>
              <div>
                <dt>{t('投递位置', 'Destination')}</dt>
                <dd>{t('好友 Steam 个人资料页', 'Friends’ Steam profile pages')}</dd>
              </div>
            </dl>
            <div className="confirm-recipients">
              {selectedRecords.map((friend) => (
                <span key={friend.steamId}>{friend.displayName}</span>
              ))}
            </div>
            <div className="confirm-message">{renderedPreview}</div>
            <div className="experimental-note">
              {t('上方显示首位好友的最终正文，其余对象会分别替换昵称。此功能使用 Steam Community 网页接口；接口变动或频率控制可能导致失败。', 'The preview shows the final text for the first friend. Names are replaced for each recipient. This uses the Steam Community web interface; changes and rate limits may cause failures.')}
            </div>
            <label className="confirm-check">
              <input
                type="checkbox"
                checked={confirmed}
                disabled={submitting}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              {t('我已核对发送账号、对象和正文，确认开始逐条发送', 'I checked the account, recipients, and message and confirm sequential delivery')}
            </label>
            {issues.length > 0 && <div className="inline-warning">{issues.map((issue) => <p key={issue.code}>{issueText(issue, t)}</p>)}</div>}
            {submissionError && <div className="inline-error" role="alert">{t('创建发送批次失败：', 'Could not create batch: ')}{submissionError}</div>}
            <button className="primary wide" disabled={!confirmed || !canStart} onClick={() => void startBatch()}>
              {submitting ? t('正在创建批次…', 'Creating batch…') : t('开始发送', 'Start sending')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function ActiveBatchPanel({ batch, runAction }: { batch: BatchRecord; runAction: RunAction }): React.JSX.Element {
  const { t } = useI18n()
  const [pendingAction, setPendingAction] = useState(false)
  const actionLock = useRef(false)
  const perform = async (label: string, action: () => Promise<void>): Promise<void> => {
    if (actionLock.current) return
    actionLock.current = true
    setPendingAction(true)
    try { await runAction(label, action) }
    finally { actionLock.current = false; setPendingAction(false) }
  }
  const progress = batch.total ? Math.round((batch.completed / batch.total) * 100) : 0
  const active = ['queued', 'running', 'paused'].includes(batch.status)
  const failures = batch.deliveries.filter((delivery) => delivery.error)
  const statuses = {
    queued: t('等待中', 'Queued'), running: t('发送中', 'Sending'), paused: t('已暂停', 'Paused'),
    completed: t('已结束', 'Finished'), cancelled: t('已取消', 'Cancelled')
  }
  return (
    <section className="card active-batch-card">
      <div className="active-batch-title">
        <span>
          <i className={batch.status} /> {active ? t('当前批次', 'Current batch') : t('最近批次结果', 'Latest batch result')}
        </span>
        <b>{statuses[batch.status]}</b>
      </div>
      <div className="progress-track">
        <i style={{ width: `${progress}%` }} />
      </div>
      <div className="progress-facts">
        <span>{batch.completed} / {batch.total}</span>
        <span className="success">{t('成功', 'Accepted')} {batch.succeeded}</span>
        <span className="failed">{t('失败/待核对', 'Failed/uncertain')} {batch.failed}</span>
      </div>
      {failures.slice(-3).map((delivery) => <div className="inline-warning" key={delivery.id}>
        <strong>{delivery.friendName}</strong>: {delivery.error}
      </div>)}
      {failures.length > 3 && <small>{t('更多详情请查看发送记录。', 'See delivery history for more details.')}</small>}
      {active && <div className="batch-controls">
        {batch.status === 'running' ? (
          <button disabled={pendingAction} onClick={() => void perform(t('正在暂停', 'Pausing'), async () => unwrap(await window.steamCommenter.pauseBatch(batch.id)))}>
            {t('暂停', 'Pause')}
          </button>
        ) : (
          <button className="primary" disabled={pendingAction} onClick={() => void perform(t('正在恢复', 'Resuming'), async () => unwrap(await window.steamCommenter.resumeBatch(batch.id)))}>
            {t('继续', 'Resume')}
          </button>
        )}
        <button
          className="danger-text"
          disabled={pendingAction}
          onClick={() => {
            if (window.confirm(t('取消后，尚未开始的好友将不再发送。当前请求若已提交则不会撤回。', 'Cancel remaining deliveries? A request already submitted cannot be recalled.'))) {
              void perform(t('正在取消', 'Cancelling'), async () => unwrap(await window.steamCommenter.cancelBatch(batch.id)))
            }
          }}
        >
          {t('取消批次', 'Cancel batch')}
        </button>
      </div>}
    </section>
  )
}

function issueText(issue: ComposerIssue, t: Translate): string {
  switch (issue.code) {
    case 'login': return t('当前账号尚未登录，请先登录或恢复会话。', 'Sign in to the current account or restore its session first.')
    case 'noRecipients': return t('请至少选择一位已同步的好友。', 'Select at least one synced friend.')
    case 'blacklisted': return t('选中的好友均在黑名单中；请选择其他好友。', 'All selected friends are blacklisted. Choose other friends.')
    case 'tooManyRecipients': return t(`已超过单批 ${MAX_BATCH_RECIPIENTS} 人上限。可点击“仅保留前 ${MAX_BATCH_RECIPIENTS} 位”。`, `More than ${MAX_BATCH_RECIPIENTS} recipients selected. Use “Keep first ${MAX_BATCH_RECIPIENTS} only”.`)
    case 'emptyMessage': return t('留言正文不能为空。', 'Enter a comment message.')
    case 'messageTooLong': return t(`留言正文超过 ${MAX_COMMENT_LENGTH} 字符。`, `The message exceeds ${MAX_COMMENT_LENGTH} characters.`)
    case 'renderedMessageTooLong': return t(`替换昵称后，给“${issue.friendName}”的留言超过 ${MAX_COMMENT_LENGTH} 字符。`, `After inserting names, the comment for “${issue.friendName}” exceeds ${MAX_COMMENT_LENGTH} characters.`)
    case 'invalidDelay': return t('基础间隔必须在 1–300 秒之间。', 'The base interval must be between 1 and 300 seconds.')
    case 'activeBatch': return t('当前账号有未完成批次，请在右侧继续或取消后再创建。', 'This account has an unfinished batch. Resume or cancel it on the right first.')
  }
}

function formatDeliveryDuration(milliseconds: number, language: string): string {
  if (!Number.isFinite(milliseconds)) return '-'
  if (language !== 'en') return formatDuration(milliseconds)
  const seconds = Math.ceil(milliseconds / 1000)
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}
