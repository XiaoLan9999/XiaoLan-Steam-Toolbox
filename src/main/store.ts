import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { backup, DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import {
  AccountRecord,
  AccountSettings,
  BatchRecord,
  BatchStatus,
  CommentCheckResult,
  CommentScanJob,
  DeliveryRecord,
  DeliveryStatus,
  FriendGroup,
  FriendNameChangeRecord,
  FriendPolicy,
  FriendRecord,
  FriendRemovalRecord,
  SteamEmoticon
} from '../shared/types'
import { DomainError, validateDelay } from '../shared/domain'
import type { UpdatePreferences } from '../shared/update-types'
import { defaultUpdatePreferences, normalizeUpdatePreferences } from '../shared/update-preferences'

export interface SecretCipher {
  isAvailable(): boolean
  backend(): string
  encrypt(value: string): Buffer
  decrypt(value: Buffer): string
}

interface AccountRow {
  account_id: string
  steam_id: string
  account_name: string
  display_name: string
  avatar_url: string
  created_at: string
  last_login_at: string | null
  last_friend_sync_at: string | null
  last_emoticon_sync_at: string | null
}

interface FriendRow {
  account_id: string
  steam_id: string
  display_name: string
  avatar_url: string
  profile_url: string
  online_state: FriendRecord['onlineState']
  synced_at: string
}

interface FriendRemovalRow {
  id: string
  account_id: string
  steam_id: string
  display_name: string
  avatar_url: string
  profile_url: string
  detected_at: string | null
  restored_at: string | null
  source: FriendRemovalRecord['source']
}

interface FriendNameChangeRow {
  id: string
  account_id: string
  steam_id: string
  old_name: string
  new_name: string
  avatar_url: string
  profile_url: string
  detected_at: string
}

interface GroupRow {
  id: string
  account_id: string
  name: string
  color: string
  created_at: string
}

interface EmoticonRow {
  account_id: string
  token: string
  name: string
  image_url: string
  item_count: number
}

interface BatchRow {
  id: string
  account_id: string
  message_template: string
  delay_ms: number
  status: BatchStatus
  total: number
  completed: number
  succeeded: number
  failed: number
  created_at: string
  started_at: string | null
  finished_at: string | null
}

interface DeliveryRow {
  id: string
  batch_id: string
  friend_steam_id: string
  friend_name: string
  rendered_message: string
  status: DeliveryStatus
  error: string | null
  remote_comment_id: string | null
  created_at: string
  sent_at: string | null
}

interface SettingsRow {
  account_id: string
  draft: string
  delay_ms: number
}

interface FriendPolicyRow {
  account_id: string
  steam_id: string
  blacklisted: number
  comment_status: FriendPolicy['commentStatus']
  comment_reason: string | null
  comment_checked_at: string | null
}

interface CommentScanRow {
  id: string
  account_id: string
  status: CommentScanJob['status']
  total: number
  completed: number
  allowed: number
  blocked: number
  unknown: number
  current_steam_id: string | null
  last_error: string | null
  delay_ms: number
  created_at: string
  updated_at: string
}

export interface CommentScanItem {
  steamId: string
  attemptId: string
}

export interface DeliverySeed {
  friendSteamId: string
  friendName: string
  renderedMessage: string
}

const now = (): string => new Date().toISOString()

export class SqliteStore {
  private readonly db: DatabaseSync

  constructor(
    databasePath: string,
    private readonly cipher: SecretCipher
  ) {
    mkdirSync(dirname(databasePath), { recursive: true })
    this.db = new DatabaseSync(databasePath)
    this.db.exec('PRAGMA foreign_keys = ON;')
    this.db.exec('PRAGMA journal_mode = WAL;')
    this.db.exec('PRAGMA busy_timeout = 5000;')
    this.migrate()
    this.recoverInterruptedBatches()
    this.recoverInterruptedCommentScans()
  }

  close(): void {
    this.db.close()
  }

  getLanguage(): 'zh-CN' | 'en' {
    const row = this.db.prepare("SELECT value FROM app_meta WHERE key = 'ui_language'")
      .get() as unknown as { value: string } | undefined
    return row?.value === 'en' ? 'en' : 'zh-CN'
  }

  getUpdatePreferences(): UpdatePreferences {
    const row = this.db.prepare("SELECT value FROM app_meta WHERE key = 'update_preferences'")
      .get() as unknown as { value: string } | undefined
    try { return row ? normalizeUpdatePreferences(JSON.parse(row.value)) : defaultUpdatePreferences() }
    catch { return defaultUpdatePreferences() }
  }

  setUpdatePreferences(preferences: UpdatePreferences): void {
    try {
      this.setMetaInTransaction('update_preferences', JSON.stringify(normalizeUpdatePreferences(preferences)))
    } catch {
      throw new DomainError('INVALID_UPDATE_PREFERENCES', '更新设置无效，请使用不含账号密码或参数的 HTTPS 代理前缀（最多 5 条）')
    }
  }

  setLanguage(language: 'zh-CN' | 'en'): void {
    if (language !== 'zh-CN' && language !== 'en') {
      throw new DomainError('INVALID_LANGUAGE', '不支持的界面语言')
    }
    this.setMetaInTransaction('ui_language', language)
  }

  async exportDatabase(destination: string): Promise<void> {
    await backup(this.db, destination)
    const exported = new DatabaseSync(destination)
    try {
      exported.exec('PRAGMA journal_mode = DELETE; PRAGMA secure_delete = ON;')
      exported.exec('DELETE FROM account_secrets; VACUUM;')
    } finally {
      exported.close()
    }
  }

  getSecretStorageInfo(): { available: boolean; backend: string } {
    return { available: this.cipher.isAvailable(), backend: this.cipher.backend() }
  }

  getAccounts(): AccountRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM accounts ORDER BY last_login_at DESC, created_at DESC')
      .all() as unknown as AccountRow[]
    return rows.map(mapAccount)
  }

  getAccount(accountId: string): AccountRecord | null {
    const row = this.db
      .prepare('SELECT * FROM accounts WHERE account_id = ?')
      .get(accountId) as unknown as AccountRow | undefined
    return row ? mapAccount(row) : null
  }

  upsertAccount(account: AccountRecord, refreshToken?: string): void {
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO accounts (
             account_id, steam_id, account_name, display_name, avatar_url, created_at,
             last_login_at, last_friend_sync_at, last_emoticon_sync_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(account_id) DO UPDATE SET
             account_name = excluded.account_name,
             display_name = excluded.display_name,
             avatar_url = excluded.avatar_url,
             last_login_at = excluded.last_login_at`
        )
        .run(
          account.id,
          account.steamId,
          account.accountName,
          account.displayName,
          account.avatarUrl,
          account.createdAt,
          account.lastLoginAt,
          account.lastFriendSyncAt,
          account.lastEmoticonSyncAt
        )

      this.db
        .prepare(
          'INSERT OR IGNORE INTO account_settings (account_id, draft, delay_ms) VALUES (?, ?, ?)'
        )
        .run(account.id, '', 15_000)

      if (refreshToken) {
        this.saveRefreshTokenInTransaction(account.id, refreshToken)
      }
      this.setMetaInTransaction('active_account_id', account.id)
    })
  }

  updateAccountProfile(
    accountId: string,
    values: { accountName: string; displayName: string; avatarUrl: string }
  ): void {
    this.db
      .prepare(
        `UPDATE accounts
         SET account_name = ?, display_name = ?, avatar_url = ?, last_login_at = ?
         WHERE account_id = ?`
      )
      .run(values.accountName, values.displayName, values.avatarUrl, now(), accountId)
  }

  deleteAccount(accountId: string): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM accounts WHERE account_id = ?').run(accountId)
      if (this.getActiveAccountId() === accountId) {
        this.setMetaInTransaction('active_account_id', '')
      }
    })
  }

  getActiveAccountId(): string | null {
    const row = this.db
      .prepare("SELECT value FROM app_meta WHERE key = 'active_account_id'")
      .get() as unknown as { value: string } | undefined
    return row?.value || null
  }

  setActiveAccountId(accountId: string): void {
    if (!this.getAccount(accountId)) {
      throw new DomainError('ACCOUNT_NOT_FOUND', '账号不存在')
    }
    this.setMetaInTransaction('active_account_id', accountId)
  }

  getRefreshToken(accountId: string): string | null {
    if (!this.cipher.isAvailable()) return null
    const row = this.db
      .prepare('SELECT refresh_token_cipher FROM account_secrets WHERE account_id = ?')
      .get(accountId) as unknown as { refresh_token_cipher: Uint8Array } | undefined
    if (!row) return null

    try {
      return this.cipher.decrypt(Buffer.from(row.refresh_token_cipher))
    } catch {
      throw new DomainError(
        'SECRET_DECRYPT_FAILED',
        '已保存的登录令牌无法由当前 Windows 用户解密，请重新登录'
      )
    }
  }

  replaceFriends(
    accountId: string,
    friends: Omit<FriendRecord, 'groupIds'>[],
    options?: { verifiedNameIds?: ReadonlySet<string> }
  ): void {
    validateFriendSync(accountId, friends)
    const syncedAt = now()
    const incomingIds = new Set(friends.map((friend) => friend.steamId))
    this.transaction(() => {
      if (!this.getAccount(accountId)) {
        throw new DomainError('ACCOUNT_NOT_FOUND', '同步账号不存在')
      }
      const previous = this.db.prepare(
        'SELECT * FROM friends WHERE account_id = ? AND is_active = 1'
      ).all(accountId) as unknown as FriendRow[]
      const recordRemoval = this.db.prepare(
        `INSERT INTO friend_removals
         (id, account_id, steam_id, display_name, avatar_url, profile_url, detected_at, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'sync')`
      )
      for (const friend of previous) {
        if (!incomingIds.has(friend.steam_id)) {
          recordRemoval.run(randomUUID(), accountId, friend.steam_id, friend.display_name,
            friend.avatar_url, friend.profile_url, syncedAt)
        }
      }
      this.db.prepare('UPDATE friends SET is_active = 0 WHERE account_id = ?').run(accountId)
      const statement = this.db.prepare(
        `INSERT INTO friends (
           account_id, steam_id, display_name, avatar_url, profile_url, online_state,
           synced_at, is_active
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT(account_id, steam_id) DO UPDATE SET
           display_name = excluded.display_name,
           avatar_url = excluded.avatar_url,
           profile_url = excluded.profile_url,
           online_state = excluded.online_state,
           synced_at = excluded.synced_at,
           is_active = 1`
      )
      const trustedNames = new Map(
        (this.db.prepare(
          'SELECT steam_id, display_name FROM friend_name_baselines WHERE account_id = ?'
        ).all(accountId) as unknown as Array<{ steam_id: string; display_name: string }>)
          .map((row) => [row.steam_id, row.display_name])
      )
      const recordNameChange = this.db.prepare(
        `INSERT INTO friend_name_changes
         (id, account_id, steam_id, old_name, new_name, avatar_url, profile_url, detected_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      const updateNameBaseline = this.db.prepare(
        `INSERT INTO friend_name_baselines (account_id, steam_id, display_name, updated_at)
         VALUES (?, ?, ?, ?) ON CONFLICT(account_id, steam_id) DO UPDATE SET
           display_name = excluded.display_name, updated_at = excluded.updated_at`
      )
      for (const friend of friends) {
        statement.run(
          accountId,
          friend.steamId,
          friend.displayName,
          friend.avatarUrl,
          friend.profileUrl,
          friend.onlineState,
          syncedAt
        )
        if (!friend.displayName.trim() ||
          (options?.verifiedNameIds && !options.verifiedNameIds.has(friend.steamId))) continue
        const oldName = trustedNames.get(friend.steamId)
        if (oldName !== undefined && oldName !== friend.displayName) {
          recordNameChange.run(randomUUID(), accountId, friend.steamId, oldName,
            friend.displayName, friend.avatarUrl, friend.profileUrl, syncedAt)
        }
        updateNameBaseline.run(accountId, friend.steamId, friend.displayName, syncedAt)
      }
      this.db.prepare(
        `UPDATE friend_removals SET restored_at = ?
         WHERE account_id = ? AND restored_at IS NULL
           AND EXISTS (SELECT 1 FROM friends
             WHERE friends.account_id = friend_removals.account_id
               AND friends.steam_id = friend_removals.steam_id AND friends.is_active = 1)`
      ).run(syncedAt, accountId)
      this.db
        .prepare('UPDATE accounts SET last_friend_sync_at = ? WHERE account_id = ?')
        .run(syncedAt, accountId)
    })
  }

  getFriendNameChanges(accountId: string): FriendNameChangeRecord[] {
    const rows = this.db.prepare(
      `SELECT * FROM friend_name_changes WHERE account_id = ?
       ORDER BY detected_at DESC, rowid DESC`
    ).all(accountId) as unknown as FriendNameChangeRow[]
    return rows.map((row) => ({
      id: row.id,
      accountId: row.account_id,
      steamId: row.steam_id,
      oldName: row.old_name,
      newName: row.new_name,
      avatarUrl: row.avatar_url,
      profileUrl: row.profile_url,
      detectedAt: row.detected_at
    }))
  }

  getFriendRemovals(accountId: string): FriendRemovalRecord[] {
    const rows = this.db.prepare(
      `SELECT * FROM friend_removals WHERE account_id = ?
       ORDER BY detected_at DESC, rowid DESC`
    ).all(accountId) as unknown as FriendRemovalRow[]
    return rows.map((row) => ({
      id: row.id,
      accountId: row.account_id,
      steamId: row.steam_id,
      displayName: row.display_name,
      avatarUrl: row.avatar_url,
      profileUrl: row.profile_url,
      detectedAt: row.detected_at,
      restoredAt: row.restored_at,
      source: row.source
    }))
  }

  getFriends(accountId: string): FriendRecord[] {
    const rows = this.db
      .prepare(
        `SELECT account_id, steam_id, display_name, avatar_url, profile_url, online_state, synced_at
         FROM friends WHERE account_id = ? AND is_active = 1
         ORDER BY display_name COLLATE NOCASE`
      )
      .all(accountId) as unknown as FriendRow[]
    const memberships = this.db
      .prepare(
        `SELECT friend_steam_id, group_id FROM friend_group_members
         WHERE account_id = ? ORDER BY group_id`
      )
      .all(accountId) as unknown as Array<{ friend_steam_id: string; group_id: string }>
    const groupMap = new Map<string, string[]>()
    for (const membership of memberships) {
      const values = groupMap.get(membership.friend_steam_id) ?? []
      values.push(membership.group_id)
      groupMap.set(membership.friend_steam_id, values)
    }

    return rows.map((row) => ({
      accountId: row.account_id,
      steamId: row.steam_id,
      displayName: row.display_name,
      avatarUrl: row.avatar_url,
      profileUrl: row.profile_url,
      onlineState: row.online_state,
      groupIds: groupMap.get(row.steam_id) ?? [],
      syncedAt: row.synced_at
    }))
  }

  getFriend(accountId: string, steamId: string): FriendRecord | null {
    return this.getFriends(accountId).find((friend) => friend.steamId === steamId) ?? null
  }

  getFriendPolicies(accountId: string): FriendPolicy[] {
    const rows = this.db.prepare(
      `SELECT f.account_id, f.steam_id,
         COALESCE(p.blacklisted, 0) AS blacklisted,
         COALESCE(p.comment_status, 'unchecked') AS comment_status,
         p.comment_reason, p.comment_checked_at
       FROM friends f LEFT JOIN friend_policies p
         ON p.account_id = f.account_id AND p.steam_id = f.steam_id
       WHERE f.account_id = ? AND f.is_active = 1 ORDER BY f.steam_id`
    ).all(accountId) as unknown as FriendPolicyRow[]
    return rows.map((row) => ({
      accountId: row.account_id,
      steamId: row.steam_id,
      blacklisted: row.blacklisted === 1,
      commentStatus: row.comment_status,
      commentReason: row.comment_reason,
      commentCheckedAt: row.comment_checked_at
    }))
  }

  setBlacklist(accountId: string, friendSteamIds: string[], blacklisted: boolean): void {
    if (typeof blacklisted !== 'boolean') {
      throw new DomainError('INVALID_BLACKLIST', '黑名单状态无效')
    }
    const ids = this.validatePolicyFriends(accountId, friendSteamIds)
    this.transaction(() => {
      const statement = this.db.prepare(
        `INSERT INTO friend_policies (account_id, steam_id, blacklisted)
         VALUES (?, ?, ?) ON CONFLICT(account_id, steam_id)
         DO UPDATE SET blacklisted = excluded.blacklisted`
      )
      for (const id of ids) statement.run(accountId, id, blacklisted ? 1 : 0)
    })
  }

  isBlacklisted(accountId: string, steamId: string): boolean {
    const row = this.db.prepare(
      'SELECT blacklisted FROM friend_policies WHERE account_id = ? AND steam_id = ?'
    ).get(accountId, steamId) as unknown as { blacklisted: number } | undefined
    return row?.blacklisted === 1
  }

  hasActiveFriend(accountId: string, steamId: string): boolean {
    return Boolean(this.db.prepare(
      'SELECT 1 FROM friends WHERE account_id = ? AND steam_id = ? AND is_active = 1'
    ).get(accountId, steamId))
  }

  createCommentScan(accountId: string, friendSteamIds: string[], delayMs: number): CommentScanJob {
    const ids = this.validatePolicyFriends(accountId, friendSteamIds)
    if (!Number.isFinite(delayMs)) throw new DomainError('INVALID_DELAY', '检查间隔无效')
    const delay = Math.max(5_000, Math.min(60_000, Math.round(delayMs)))
    const id = randomUUID()
    const timestamp = now()
    this.transaction(() => {
      if (this.getActiveCommentScan(accountId)) {
        throw new DomainError('SCAN_ALREADY_ACTIVE', '当前账号已有未完成检查，请先继续或取消')
      }
      this.db.prepare(
        `INSERT INTO comment_scan_jobs
         (id, account_id, status, total, delay_ms, created_at, updated_at)
         VALUES (?, ?, 'running', ?, ?, ?, ?)`
      ).run(id, accountId, ids.length, delay, timestamp, timestamp)
      const insert = this.db.prepare(
        `INSERT INTO comment_scan_items (job_id, friend_steam_id, position, status)
         VALUES (?, ?, ?, 'pending')`
      )
      ids.forEach((steamId, position) => insert.run(id, steamId, position))
    })
    return this.getCommentScan(id)!
  }

  getCommentScan(jobId: string): CommentScanJob | null {
    const row = this.db.prepare('SELECT * FROM comment_scan_jobs WHERE id = ?')
      .get(jobId) as unknown as CommentScanRow | undefined
    return row ? mapCommentScan(row) : null
  }

  getLatestCommentScan(accountId: string): CommentScanJob | null {
    const row = this.db.prepare(
      'SELECT * FROM comment_scan_jobs WHERE account_id = ? ORDER BY rowid DESC LIMIT 1'
    ).get(accountId) as unknown as CommentScanRow | undefined
    return row ? mapCommentScan(row) : null
  }

  getActiveCommentScan(accountId: string): CommentScanJob | null {
    const row = this.db.prepare(
      `SELECT * FROM comment_scan_jobs
       WHERE account_id = ? AND status IN ('running', 'paused') LIMIT 1`
    ).get(accountId) as unknown as CommentScanRow | undefined
    return row ? mapCommentScan(row) : null
  }

  setCommentScanRunning(jobId: string): void {
    const job = this.requireCommentScan(jobId)
    if (!['paused', 'running'].includes(job.status)) {
      throw new DomainError('SCAN_NOT_RESUMABLE', '这个检查任务不能继续')
    }
    this.db.prepare(
      "UPDATE comment_scan_jobs SET status = 'running', last_error = NULL, updated_at = ? WHERE id = ?"
    ).run(now(), jobId)
  }

  pauseCommentScan(jobId: string, reason?: string): void {
    const job = this.requireCommentScan(jobId)
    if (!['paused', 'running'].includes(job.status)) return
    this.transaction(() => {
      this.db.prepare(
        `UPDATE comment_scan_items SET status = 'pending', attempt_id = NULL
         WHERE job_id = ? AND status = 'checking'`
      ).run(jobId)
      this.db.prepare(
        `UPDATE comment_scan_jobs SET status = 'paused', current_steam_id = NULL,
         last_error = COALESCE(?, last_error), updated_at = ? WHERE id = ?`
      ).run(reason?.slice(0, 1000) ?? null, now(), jobId)
    })
  }

  cancelCommentScan(jobId: string): void {
    const job = this.requireCommentScan(jobId)
    if (!['paused', 'running'].includes(job.status)) return
    this.transaction(() => {
      this.db.prepare(
        `UPDATE comment_scan_items SET status = 'cancelled', attempt_id = NULL
         WHERE job_id = ? AND status IN ('pending', 'checking')`
      ).run(jobId)
      this.db.prepare(
        `UPDATE comment_scan_jobs SET status = 'cancelled', current_steam_id = NULL,
         updated_at = ? WHERE id = ?`
      ).run(now(), jobId)
    })
  }

  takeNextCommentScanItem(jobId: string): CommentScanItem | null {
    let item: CommentScanItem | null = null
    this.transaction(() => {
      const job = this.getCommentScan(jobId)
      if (!job || job.status !== 'running' || job.currentSteamId) return
      const row = this.db.prepare(
        `SELECT friend_steam_id FROM comment_scan_items
         WHERE job_id = ? AND status = 'pending' ORDER BY position LIMIT 1`
      ).get(jobId) as unknown as { friend_steam_id: string } | undefined
      if (!row) {
        this.db.prepare(
          "UPDATE comment_scan_jobs SET status = 'completed', updated_at = ? WHERE id = ?"
        ).run(now(), jobId)
        return
      }
      item = { steamId: row.friend_steam_id, attemptId: randomUUID() }
      this.db.prepare(
        `UPDATE comment_scan_items SET status = 'checking', attempt_id = ?
         WHERE job_id = ? AND friend_steam_id = ?`
      ).run(item.attemptId, jobId, item.steamId)
      this.db.prepare(
        'UPDATE comment_scan_jobs SET current_steam_id = ?, updated_at = ? WHERE id = ?'
      ).run(item.steamId, now(), jobId)
    })
    return item
  }

  completeCommentScanItem(
    jobId: string,
    item: CommentScanItem,
    result: CommentCheckResult,
    pauseReason?: string
  ): boolean {
    if (!['allowed', 'blocked', 'unknown'].includes(result.status)) {
      throw new DomainError('INVALID_CHECK_RESULT', '检查结果无效')
    }
    let accepted = false
    this.transaction(() => {
      const job = this.getCommentScan(jobId)
      if (!job || job.status !== 'running') return
      const timestamp = now()
      const reason = result.reason.slice(0, 1000)
      const changed = this.db.prepare(
        `UPDATE comment_scan_items SET status = 'done', result = ?, reason = ?,
         checked_at = ?, attempt_id = NULL
         WHERE job_id = ? AND friend_steam_id = ? AND status = 'checking' AND attempt_id = ?`
      ).run(result.status, reason, timestamp, jobId, item.steamId, item.attemptId)
      if (!changed.changes) return
      // Preserve the independent blacklist flag when refreshing eligibility.
      this.db.prepare(
        `INSERT INTO friend_policies
         (account_id, steam_id, comment_status, comment_reason, comment_checked_at)
         VALUES (?, ?, ?, ?, ?) ON CONFLICT(account_id, steam_id) DO UPDATE SET
         comment_status = excluded.comment_status, comment_reason = excluded.comment_reason,
         comment_checked_at = excluded.comment_checked_at`
      ).run(job.accountId, item.steamId, result.status, reason, timestamp)
      this.db.prepare(
        `UPDATE comment_scan_jobs SET completed = completed + 1,
         allowed = allowed + ?, blocked = blocked + ?, unknown = unknown + ?,
         current_steam_id = NULL, updated_at = ?, last_error = ?,
         status = CASE WHEN ? IS NOT NULL THEN 'paused'
           WHEN completed + 1 >= total THEN 'completed' ELSE status END
         WHERE id = ?`
      ).run(
        result.status === 'allowed' ? 1 : 0, result.status === 'blocked' ? 1 : 0,
        result.status === 'unknown' ? 1 : 0, timestamp, pauseReason?.slice(0, 1000) ?? null,
        pauseReason ?? null, jobId
      )
      accepted = true
    })
    return accepted
  }

  getGroups(accountId: string): FriendGroup[] {
    const rows = this.db
      .prepare('SELECT * FROM friend_groups WHERE account_id = ? ORDER BY created_at')
      .all(accountId) as unknown as GroupRow[]
    return rows.map(mapGroup)
  }

  createGroup(accountId: string, rawName: string, rawColor: string): FriendGroup {
    const name = validateGroupName(rawName)
    const color = /^#[0-9a-fA-F]{6}$/.test(rawColor) ? rawColor : '#66c0f4'
    const group: FriendGroup = {
      id: randomUUID(),
      accountId,
      name,
      color,
      createdAt: now()
    }
    try {
      this.db
        .prepare(
          'INSERT INTO friend_groups (id, account_id, name, color, created_at) VALUES (?, ?, ?, ?, ?)'
        )
        .run(group.id, accountId, name, color, group.createdAt)
    } catch (error) {
      if (String(error).includes('UNIQUE')) {
        throw new DomainError('GROUP_EXISTS', '这个账号下已经有同名分组')
      }
      throw error
    }
    return group
  }

  renameGroup(accountId: string, groupId: string, rawName: string): void {
    const name = validateGroupName(rawName)
    try {
      const result = this.db
        .prepare('UPDATE friend_groups SET name = ? WHERE account_id = ? AND id = ?')
        .run(name, accountId, groupId)
      if (result.changes === 0) throw new DomainError('GROUP_NOT_FOUND', '分组不存在')
    } catch (error) {
      if (String(error).includes('UNIQUE')) {
        throw new DomainError('GROUP_EXISTS', '这个账号下已经有同名分组')
      }
      throw error
    }
  }

  deleteGroup(accountId: string, groupId: string): void {
    this.db
      .prepare('DELETE FROM friend_groups WHERE account_id = ? AND id = ?')
      .run(accountId, groupId)
  }

  setFriendGroups(accountId: string, friendSteamIds: string[], groupIds: string[]): void {
    const uniqueFriendIds = [...new Set(friendSteamIds)]
    const uniqueGroupIds = [...new Set(groupIds)]
    const knownFriends = new Set(this.getFriends(accountId).map((friend) => friend.steamId))
    const knownGroups = new Set(this.getGroups(accountId).map((group) => group.id))
    if (uniqueFriendIds.some((id) => !knownFriends.has(id))) {
      throw new DomainError('INVALID_FRIEND', '只能给当前账号已同步的好友分组')
    }
    if (uniqueGroupIds.some((id) => !knownGroups.has(id))) {
      throw new DomainError('INVALID_GROUP', '分组不属于当前账号')
    }

    this.transaction(() => {
      const remove = this.db.prepare(
        'DELETE FROM friend_group_members WHERE account_id = ? AND friend_steam_id = ?'
      )
      const insert = this.db.prepare(
        `INSERT INTO friend_group_members (account_id, group_id, friend_steam_id)
         VALUES (?, ?, ?)`
      )
      for (const friendId of uniqueFriendIds) {
        remove.run(accountId, friendId)
        for (const groupId of uniqueGroupIds) insert.run(accountId, groupId, friendId)
      }
    })
  }

  getSettings(accountId: string): AccountSettings {
    const row = this.db
      .prepare('SELECT account_id, draft, delay_ms FROM account_settings WHERE account_id = ?')
      .get(accountId) as unknown as SettingsRow | undefined
    return row
      ? { accountId: row.account_id, draft: row.draft, delayMs: row.delay_ms }
      : { accountId, draft: '', delayMs: 15_000 }
  }

  updateSettings(accountId: string, draft: string, delayMs: number): void {
    this.db
      .prepare(
        `INSERT INTO account_settings (account_id, draft, delay_ms) VALUES (?, ?, ?)
         ON CONFLICT(account_id) DO UPDATE SET draft = excluded.draft, delay_ms = excluded.delay_ms`
      )
      .run(accountId, draft, validateDelay(delayMs))
  }

  replaceEmoticons(accountId: string, emoticons: SteamEmoticon[]): void {
    const syncedAt = now()
    this.transaction(() => {
      this.db.prepare('DELETE FROM emoticons WHERE account_id = ?').run(accountId)
      const insert = this.db.prepare(
        `INSERT INTO emoticons (account_id, token, name, image_url, item_count)
         VALUES (?, ?, ?, ?, ?)`
      )
      for (const emoticon of emoticons) {
        insert.run(accountId, emoticon.token, emoticon.name, emoticon.imageUrl, emoticon.count)
      }
      this.db
        .prepare('UPDATE accounts SET last_emoticon_sync_at = ? WHERE account_id = ?')
        .run(syncedAt, accountId)
    })
  }

  getEmoticons(accountId: string): SteamEmoticon[] {
    const rows = this.db
      .prepare('SELECT * FROM emoticons WHERE account_id = ? ORDER BY name COLLATE NOCASE')
      .all(accountId) as unknown as EmoticonRow[]
    return rows.map((row) => ({
      accountId: row.account_id,
      token: row.token,
      name: row.name,
      imageUrl: row.image_url,
      count: row.item_count
    }))
  }

  createBatch(
    accountId: string,
    messageTemplate: string,
    delayMs: number,
    deliveries: DeliverySeed[]
  ): BatchRecord {
    const batchId = randomUUID()
    const createdAt = now()
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO batches (
             id, account_id, message_template, delay_ms, status, total, completed,
             succeeded, failed, created_at
           ) VALUES (?, ?, ?, ?, 'queued', ?, 0, 0, 0, ?)`
        )
        .run(batchId, accountId, messageTemplate, delayMs, deliveries.length, createdAt)

      const insert = this.db.prepare(
        `INSERT INTO deliveries (
           id, batch_id, friend_steam_id, friend_name, rendered_message, status, created_at
         ) VALUES (?, ?, ?, ?, ?, 'pending', ?)`
      )
      for (const delivery of deliveries) {
        insert.run(
          randomUUID(),
          batchId,
          delivery.friendSteamId,
          delivery.friendName,
          delivery.renderedMessage,
          createdAt
        )
      }
    })
    return this.getBatch(batchId)!
  }

  getBatch(batchId: string): BatchRecord | null {
    const row = this.db.prepare('SELECT * FROM batches WHERE id = ?').get(batchId) as unknown as
      | BatchRow
      | undefined
    if (!row) return null
    const deliveries = this.db
      .prepare('SELECT * FROM deliveries WHERE batch_id = ? ORDER BY created_at, id')
      .all(batchId) as unknown as DeliveryRow[]
    return mapBatch(row, deliveries)
  }

  getRecentBatches(accountId: string, limit = 20): BatchRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM batches WHERE account_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(accountId, limit) as unknown as BatchRow[]
    return rows.map((row) => {
      const deliveries = this.db
        .prepare('SELECT * FROM deliveries WHERE batch_id = ? ORDER BY created_at, id')
        .all(row.id) as unknown as DeliveryRow[]
      return mapBatch(row, deliveries)
    })
  }

  getActiveBatch(accountId: string): BatchRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM batches
         WHERE account_id = ? AND status IN ('queued', 'running', 'paused')
         ORDER BY created_at DESC LIMIT 1`
      )
      .get(accountId) as unknown as BatchRow | undefined
    return row ? this.getBatch(row.id) : null
  }

  setBatchRunning(batchId: string): void {
    const batch = this.requireBatch(batchId)
    if (!['queued', 'paused', 'running'].includes(batch.status)) {
      throw new DomainError('BATCH_NOT_RESUMABLE', '这个批次不能继续执行')
    }
    this.db
      .prepare(
        `UPDATE batches SET status = 'running', started_at = COALESCE(started_at, ?), finished_at = NULL
         WHERE id = ?`
      )
      .run(now(), batchId)
  }

  pauseBatch(batchId: string): void {
    const result = this.db
      .prepare("UPDATE batches SET status = 'paused' WHERE id = ? AND status IN ('queued', 'running')")
      .run(batchId)
    if (result.changes === 0) throw new DomainError('BATCH_NOT_PAUSABLE', '这个批次不能暂停')
  }

  cancelBatch(batchId: string): void {
    this.requireBatch(batchId)
    this.transaction(() => {
      this.db
        .prepare(
          "UPDATE deliveries SET status = 'cancelled', error = '用户取消' WHERE batch_id = ? AND status = 'pending'"
        )
        .run(batchId)
      this.db
        .prepare("UPDATE batches SET status = 'cancelled', finished_at = ? WHERE id = ?")
        .run(now(), batchId)
      this.recalculateBatchInTransaction(batchId)
    })
  }

  takeNextDelivery(batchId: string): DeliveryRecord | null {
    let selected: DeliveryRow | undefined
    this.transaction(() => {
      const batch = this.requireBatch(batchId)
      if (batch.status !== 'running') return
      selected = this.db
        .prepare(
          "SELECT * FROM deliveries WHERE batch_id = ? AND status = 'pending' ORDER BY created_at, id LIMIT 1"
        )
        .get(batchId) as unknown as DeliveryRow | undefined
      if (selected) {
        this.db.prepare("UPDATE deliveries SET status = 'sending' WHERE id = ?").run(selected.id)
        selected = { ...selected, status: 'sending' }
      }
    })
    return selected ? mapDelivery(selected) : null
  }

  completeDelivery(
    deliveryId: string,
    status: Extract<DeliveryStatus, 'sent_verified' | 'accepted_unverified' | 'failed' | 'uncertain'>,
    values: { error?: string; remoteCommentId?: string } = {}
  ): void {
    const row = this.db
      .prepare('SELECT batch_id FROM deliveries WHERE id = ?')
      .get(deliveryId) as unknown as { batch_id: string } | undefined
    if (!row) throw new DomainError('DELIVERY_NOT_FOUND', '发送任务不存在')
    this.transaction(() => {
      this.db
        .prepare(
          `UPDATE deliveries
           SET status = ?, error = ?, remote_comment_id = ?, sent_at = ?
           WHERE id = ?`
        )
        .run(
          status,
          values.error ?? null,
          values.remoteCommentId ?? null,
          status === 'sent_verified' || status === 'accepted_unverified' ? now() : null,
          deliveryId
        )
      this.recalculateBatchInTransaction(row.batch_id)
    })
  }

  resetDeliveryToPending(deliveryId: string): void {
    this.db
      .prepare("UPDATE deliveries SET status = 'pending' WHERE id = ? AND status = 'sending'")
      .run(deliveryId)
  }

  finishBatchIfDone(batchId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS remaining FROM deliveries
         WHERE batch_id = ? AND status IN ('pending', 'sending')`
      )
      .get(batchId) as unknown as { remaining: number }
    if (Number(row.remaining) > 0) return false

    this.transaction(() => {
      this.recalculateBatchInTransaction(batchId)
      const batch = this.requireBatch(batchId)
      if (batch.status !== 'cancelled') {
        this.db
          .prepare("UPDATE batches SET status = 'completed', finished_at = ? WHERE id = ?")
          .run(now(), batchId)
      }
    })
    return true
  }

  private saveRefreshTokenInTransaction(accountId: string, refreshToken: string): void {
    if (!this.cipher.isAvailable()) {
      throw new DomainError(
        'SECRET_STORAGE_UNAVAILABLE',
        '系统安全存储当前不可用，无法保存自动登录令牌'
      )
    }
    const encrypted = this.cipher.encrypt(refreshToken)
    this.db
      .prepare(
        `INSERT INTO account_secrets (account_id, refresh_token_cipher, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(account_id) DO UPDATE SET
           refresh_token_cipher = excluded.refresh_token_cipher,
           updated_at = excluded.updated_at`
      )
      .run(accountId, encrypted, now())
  }

  private validatePolicyFriends(accountId: string, friendSteamIds: string[]): string[] {
    if (!this.getAccount(accountId)) throw new DomainError('ACCOUNT_NOT_FOUND', '账号不存在')
    if (!Array.isArray(friendSteamIds) || friendSteamIds.length === 0) {
      throw new DomainError('NO_RECIPIENTS', '请至少选择一位好友')
    }
    if (friendSteamIds.length > 5_000) {
      throw new DomainError('TOO_MANY_FRIENDS', '单次最多处理 5000 位好友')
    }
    if (friendSteamIds.some((id) => typeof id !== 'string' || !/^7656119\d{10}$/.test(id))) {
      throw new DomainError('INVALID_FRIEND', '好友 Steam ID 无效')
    }
    const ids = [...new Set(friendSteamIds)]
    const known = new Set(this.db.prepare(
      'SELECT steam_id FROM friends WHERE account_id = ? AND is_active = 1'
    ).all(accountId).map((row) => row.steam_id))
    if (ids.some((id) => !known.has(id))) {
      throw new DomainError('INVALID_FRIEND', '只能处理当前账号已同步的好友')
    }
    return ids
  }

  private requireCommentScan(jobId: string): CommentScanJob {
    const job = this.getCommentScan(jobId)
    if (!job) throw new DomainError('SCAN_NOT_FOUND', '检查任务不存在')
    return job
  }

  private recoverInterruptedCommentScans(): void {
    this.transaction(() => {
      this.db.prepare(
        `UPDATE comment_scan_items SET status = 'pending', attempt_id = NULL
         WHERE status = 'checking'`
      ).run()
      this.db.prepare(
        `UPDATE comment_scan_jobs SET status = 'paused', current_steam_id = NULL,
         last_error = '应用已重启，请手动继续检查', updated_at = ? WHERE status = 'running'`
      ).run(now())
    })
  }

  private requireBatch(batchId: string): BatchRecord {
    const batch = this.getBatch(batchId)
    if (!batch) throw new DomainError('BATCH_NOT_FOUND', '批次不存在')
    return batch
  }

  private recalculateBatchInTransaction(batchId: string): void {
    const row = this.db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN status NOT IN ('pending', 'sending') THEN 1 ELSE 0 END) AS completed,
           SUM(CASE WHEN status IN ('sent_verified', 'accepted_unverified') THEN 1 ELSE 0 END) AS succeeded,
           SUM(CASE WHEN status IN ('failed', 'uncertain') THEN 1 ELSE 0 END) AS failed
         FROM deliveries WHERE batch_id = ?`
      )
      .get(batchId) as unknown as {
      total: number
      completed: number
      succeeded: number
      failed: number
    }
    this.db
      .prepare(
        'UPDATE batches SET total = ?, completed = ?, succeeded = ?, failed = ? WHERE id = ?'
      )
      .run(
        Number(row.total ?? 0),
        Number(row.completed ?? 0),
        Number(row.succeeded ?? 0),
        Number(row.failed ?? 0),
        batchId
      )
  }

  private setMetaInTransaction(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO app_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(key, value)
  }

  private recoverInterruptedBatches(): void {
    this.transaction(() => {
      this.db
        .prepare(
          `UPDATE deliveries
           SET status = 'uncertain', error = '应用在请求过程中退出；为避免重复留言，未自动重发'
           WHERE status = 'sending'`
        )
        .run()
      this.db
        .prepare("UPDATE batches SET status = 'paused' WHERE status IN ('queued', 'running')")
        .run()
      const rows = this.db
        .prepare("SELECT id FROM batches WHERE status = 'paused'")
        .all() as unknown as Array<{ id: string }>
      for (const row of rows) this.recalculateBatchInTransaction(row.id)
    })
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = operation()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private migrate(): void {
    const version = this.db.prepare('PRAGMA user_version').get() as { user_version: number }
    this.transaction(() => {
      this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        account_id TEXT PRIMARY KEY,
        steam_id TEXT NOT NULL UNIQUE,
        account_name TEXT NOT NULL,
        display_name TEXT NOT NULL,
        avatar_url TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        last_login_at TEXT,
        last_friend_sync_at TEXT,
        last_emoticon_sync_at TEXT
      );

      CREATE TABLE IF NOT EXISTS account_secrets (
        account_id TEXT PRIMARY KEY,
        refresh_token_cipher BLOB NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS account_settings (
        account_id TEXT PRIMARY KEY,
        draft TEXT NOT NULL DEFAULT '',
        delay_ms INTEGER NOT NULL DEFAULT 15000,
        FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS friends (
        account_id TEXT NOT NULL,
        steam_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        avatar_url TEXT NOT NULL DEFAULT '',
        profile_url TEXT NOT NULL,
        online_state TEXT NOT NULL DEFAULT 'unknown',
        synced_at TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (account_id, steam_id),
        FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS friend_groups (
        id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        name TEXT NOT NULL COLLATE NOCASE,
        color TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (account_id, id),
        UNIQUE (account_id, name),
        FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS friend_removals (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        steam_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        avatar_url TEXT NOT NULL DEFAULT '',
        profile_url TEXT NOT NULL,
        detected_at TEXT,
        restored_at TEXT,
        source TEXT NOT NULL CHECK (source IN ('sync', 'legacy')),
        CHECK ((source = 'sync' AND detected_at IS NOT NULL)
          OR (source = 'legacy' AND detected_at IS NULL)),
        FOREIGN KEY (account_id, steam_id)
          REFERENCES friends(account_id, steam_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS friend_policies (
        account_id TEXT NOT NULL,
        steam_id TEXT NOT NULL,
        blacklisted INTEGER NOT NULL DEFAULT 0 CHECK (blacklisted IN (0, 1)),
        comment_status TEXT NOT NULL DEFAULT 'unchecked'
          CHECK (comment_status IN ('unchecked', 'allowed', 'blocked', 'unknown')),
        comment_reason TEXT,
        comment_checked_at TEXT,
        PRIMARY KEY (account_id, steam_id),
        FOREIGN KEY (account_id, steam_id)
          REFERENCES friends(account_id, steam_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS friend_name_baselines (
        account_id TEXT NOT NULL,
        steam_id TEXT NOT NULL,
        display_name TEXT NOT NULL CHECK (length(trim(display_name)) > 0),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (account_id, steam_id),
        FOREIGN KEY (account_id, steam_id)
          REFERENCES friends(account_id, steam_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS friend_name_changes (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        steam_id TEXT NOT NULL,
        old_name TEXT NOT NULL,
        new_name TEXT NOT NULL,
        avatar_url TEXT NOT NULL DEFAULT '',
        profile_url TEXT NOT NULL,
        detected_at TEXT NOT NULL,
        CHECK (old_name <> new_name),
        FOREIGN KEY (account_id, steam_id)
          REFERENCES friends(account_id, steam_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS comment_scan_jobs (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'paused', 'completed', 'cancelled')),
        total INTEGER NOT NULL,
        completed INTEGER NOT NULL DEFAULT 0,
        allowed INTEGER NOT NULL DEFAULT 0,
        blocked INTEGER NOT NULL DEFAULT 0,
        unknown INTEGER NOT NULL DEFAULT 0,
        current_steam_id TEXT,
        last_error TEXT,
        delay_ms INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS comment_scan_items (
        job_id TEXT NOT NULL,
        friend_steam_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'checking', 'done', 'cancelled')),
        attempt_id TEXT,
        result TEXT CHECK (result IN ('allowed', 'blocked', 'unknown')),
        reason TEXT,
        checked_at TEXT,
        PRIMARY KEY (job_id, friend_steam_id),
        FOREIGN KEY (job_id) REFERENCES comment_scan_jobs(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS friend_group_members (
        account_id TEXT NOT NULL,
        group_id TEXT NOT NULL,
        friend_steam_id TEXT NOT NULL,
        PRIMARY KEY (account_id, group_id, friend_steam_id),
        FOREIGN KEY (account_id, group_id)
          REFERENCES friend_groups(account_id, id) ON DELETE CASCADE,
        FOREIGN KEY (account_id, friend_steam_id)
          REFERENCES friends(account_id, steam_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS emoticons (
        account_id TEXT NOT NULL,
        token TEXT NOT NULL,
        name TEXT NOT NULL,
        image_url TEXT NOT NULL DEFAULT '',
        item_count INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (account_id, token),
        FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS batches (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        message_template TEXT NOT NULL,
        delay_ms INTEGER NOT NULL,
        status TEXT NOT NULL,
        total INTEGER NOT NULL,
        completed INTEGER NOT NULL DEFAULT 0,
        succeeded INTEGER NOT NULL DEFAULT 0,
        failed INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS deliveries (
        id TEXT PRIMARY KEY,
        batch_id TEXT NOT NULL,
        friend_steam_id TEXT NOT NULL,
        friend_name TEXT NOT NULL,
        rendered_message TEXT NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        remote_comment_id TEXT,
        created_at TEXT NOT NULL,
        sent_at TEXT,
        UNIQUE (batch_id, friend_steam_id),
        FOREIGN KEY (batch_id) REFERENCES batches(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS app_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_friends_active
        ON friends(account_id, is_active, display_name);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_friend_removals_open
        ON friend_removals(account_id, steam_id) WHERE restored_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_friend_removals_account_detected
        ON friend_removals(account_id, detected_at DESC);
      CREATE INDEX IF NOT EXISTS idx_friend_name_changes_account_detected
        ON friend_name_changes(account_id, detected_at DESC);
      CREATE INDEX IF NOT EXISTS idx_batches_account_created
        ON batches(account_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_deliveries_batch_status
        ON deliveries(batch_id, status);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_comment_scan_active
        ON comment_scan_jobs(account_id) WHERE status IN ('running', 'paused');
      CREATE INDEX IF NOT EXISTS idx_comment_scan_pending
        ON comment_scan_items(job_id, status, position);

    `)
      if (version.user_version < 3) {
        const inactive = this.db.prepare(
          `SELECT * FROM friends f WHERE is_active = 0
           AND NOT EXISTS (SELECT 1 FROM friend_removals r
             WHERE r.account_id = f.account_id AND r.steam_id = f.steam_id)`
        ).all() as unknown as FriendRow[]
        const insertLegacy = this.db.prepare(
          `INSERT INTO friend_removals
           (id, account_id, steam_id, display_name, avatar_url, profile_url, detected_at, source)
           VALUES (?, ?, ?, ?, ?, ?, NULL, 'legacy')`
        )
        for (const friend of inactive) {
          insertLegacy.run(randomUUID(), friend.account_id, friend.steam_id,
            friend.display_name, friend.avatar_url, friend.profile_url)
        }
        this.db.exec('PRAGMA user_version = 3;')
      }
      if (version.user_version < 4) {
        this.db.exec(`INSERT OR IGNORE INTO friend_name_baselines
          (account_id, steam_id, display_name, updated_at)
          SELECT account_id, steam_id, display_name, synced_at FROM friends
          WHERE length(trim(display_name)) > 0 AND display_name <> steam_id;`)
        this.db.exec('PRAGMA user_version = 4;')
      }
    })
  }
}

function validateFriendSync(accountId: string, friends: Omit<FriendRecord, 'groupIds'>[]): void {
  if (typeof accountId !== 'string' || !accountId || !Array.isArray(friends)) {
    throw new DomainError('INVALID_FRIEND_SYNC', '好友同步数据无效，已保留原列表')
  }
  const seen = new Set<string>()
  for (const friend of friends) {
    if (!friend || typeof friend !== 'object' || friend.accountId !== accountId ||
      typeof friend.steamId !== 'string' || !/^7656119\d{10}$/.test(friend.steamId) ||
      friend.steamId === accountId || seen.has(friend.steamId) ||
      typeof friend.displayName !== 'string' || typeof friend.avatarUrl !== 'string' ||
      typeof friend.profileUrl !== 'string' || typeof friend.syncedAt !== 'string' ||
      !['in-game', 'online', 'offline', 'unknown'].includes(friend.onlineState)) {
      throw new DomainError('INVALID_FRIEND_SYNC', '好友同步数据无效，已保留原列表')
    }
    seen.add(friend.steamId)
  }
}

function validateGroupName(rawName: string): string {
  const name = rawName.trim()
  if (!name) throw new DomainError('EMPTY_GROUP_NAME', '分组名称不能为空')
  if (Array.from(name).length > 40) {
    throw new DomainError('GROUP_NAME_TOO_LONG', '分组名称最多 40 个字符')
  }
  return name
}

function mapAccount(row: AccountRow): AccountRecord {
  return {
    id: row.account_id,
    steamId: row.steam_id,
    accountName: row.account_name,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
    lastFriendSyncAt: row.last_friend_sync_at,
    lastEmoticonSyncAt: row.last_emoticon_sync_at
  }
}

function mapCommentScan(row: CommentScanRow): CommentScanJob {
  return {
    id: row.id,
    accountId: row.account_id,
    status: row.status,
    total: row.total,
    completed: row.completed,
    allowed: row.allowed,
    blocked: row.blocked,
    unknown: row.unknown,
    currentSteamId: row.current_steam_id,
    lastError: row.last_error,
    delayMs: row.delay_ms,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function mapGroup(row: GroupRow): FriendGroup {
  return {
    id: row.id,
    accountId: row.account_id,
    name: row.name,
    color: row.color,
    createdAt: row.created_at
  }
}

function mapDelivery(row: DeliveryRow): DeliveryRecord {
  return {
    id: row.id,
    batchId: row.batch_id,
    friendSteamId: row.friend_steam_id,
    friendName: row.friend_name,
    renderedMessage: row.rendered_message,
    status: row.status,
    error: row.error,
    remoteCommentId: row.remote_comment_id,
    createdAt: row.created_at,
    sentAt: row.sent_at
  }
}

function mapBatch(row: BatchRow, deliveries: DeliveryRow[]): BatchRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    messageTemplate: row.message_template,
    delayMs: row.delay_ms,
    status: row.status,
    total: row.total,
    completed: row.completed,
    succeeded: row.succeeded,
    failed: row.failed,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    deliveries: deliveries.map(mapDelivery)
  }
}
