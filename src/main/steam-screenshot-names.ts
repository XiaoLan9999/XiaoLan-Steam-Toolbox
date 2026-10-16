import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { XMLParser } from 'fast-xml-parser'
import { DomainError } from '../shared/domain'
import type { ScreenshotCatalog, ScreenshotGame } from '../shared/steam-screenshots'

interface CachedName { name: string; checkedAt: string }
interface NameCache { version: 1; games: Record<string, CachedName>; users: Record<string, CachedName> }
interface Options { cachePath: string; fetchImpl?: typeof fetch; now?: () => number }
const steamIdPattern = /^7656119\d{10}$/
const appIdPattern = /^[1-9]\d{0,9}$/
const isStoreAppId = (value: string): boolean => appIdPattern.test(value) && BigInt(value) <= 4_294_967_295n
const emptyCache = (): NameCache => ({ version: 1, games: {}, users: {} })
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const cleanName = (value: unknown): string | null => typeof value === 'string'
  && value.trim().length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value) ? value.trim() : null

export class ScreenshotNameService {
  private readonly cache: NameCache
  private readonly inFlight = new Map<string, { promise: Promise<string | null>; signal: AbortSignal }>()
  private activeRequests = 0
  private readonly waiting: Array<() => void> = []
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number

  constructor(private readonly options: Options) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now = options.now ?? Date.now
    this.cache = this.readCache()
  }

  enrich(catalog: ScreenshotCatalog, accounts: Array<{ steamId: string; displayName: string }> = []): ScreenshotCatalog {
    const localNames = new Map(accounts.map(account => [account.steamId, account.displayName]))
    return { ...catalog, users: catalog.users.map(user => {
      const remote = this.cache.users[user.steamId]
      if (remote) return { ...user, displayName: remote.name, nameSource: 'profile' as const }
      const name = cleanName(localNames.get(user.steamId))
      return user.nameSource === 'fallback' && name ? { ...user, displayName: name, nameSource: 'account' as const } : user
    }), games: catalog.games.map(game => {
      const cached = this.cache.games[game.appId]
      return game.nameSource === 'fallback' && cached ? { ...game, name: cached.name, nameSource: 'store' as const } : game
    }) }
  }

  async refresh(catalog: ScreenshotCatalog, signal: AbortSignal, changed: (pending: number) => void): Promise<void> {
    const jobs = [
      ...catalog.users.filter(user => steamIdPattern.test(user.steamId)).map(user => ({ kind: 'user' as const, id: user.steamId })),
      ...catalog.games.filter(game => game.nameSource === 'fallback' && isStoreAppId(game.appId)).map(game => ({ kind: 'game' as const, id: game.appId }))
    ]
    let index = 0
    let pending = jobs.length
    let rateLimited = false
    changed(pending)
    await Promise.all(Array.from({ length: Math.min(3, jobs.length) }, async () => {
      while (!signal.aborted && !rateLimited) {
        const job = jobs[index++]
        if (!job) return
        try { await this.lookup(job.kind, job.id, signal) }
        catch (error) { if (error instanceof DomainError && error.code === 'SCREENSHOT_NAMES_RATE_LIMITED') rateLimited = true }
        pending -= 1
        if (!signal.aborted) changed(pending)
      }
    }))
    if (!signal.aborted) await this.saveCache()
    if (rateLimited) throw new DomainError('SCREENSHOT_NAMES_RATE_LIMITED', '公开名称接口暂时限流，已保留本地名称，请稍后手动刷新')
  }

  async resolveGame(appId: string, signal: AbortSignal): Promise<ScreenshotGame> {
    if (!appIdPattern.test(appId) || BigInt(appId) > 4_294_967_295n) {
      throw new DomainError('SCREENSHOT_INVALID_GAME', '请输入有效的 Steam AppID')
    }
    let name: string | null = null
    try { name = await this.lookup('game', appId, signal) }
    catch (error) {
      if (signal.aborted || (error instanceof DomainError && error.code === 'SCREENSHOT_NAMES_RATE_LIMITED')) throw error
    }
    if (signal.aborted) throw new DomainError('SCREENSHOT_CANCELLED', '截图名称查询已取消')
    await this.saveCache()
    const resolved = name ?? this.cache.games[appId]?.name
    return { appId, name: resolved ?? `AppID ${appId}`, nameSource: resolved ? 'store' : 'fallback', installed: false, userIds: [] }
  }

  private lookup(kind: 'game' | 'user', id: string, signal: AbortSignal): Promise<string | null> {
    const key = `${kind}:${id}`
    const existing = this.inFlight.get(key)
    if (existing && !existing.signal.aborted) return existing.promise
    const task = (async () => {
      const release = await this.acquire(signal)
      try { return await this.requestName(kind, id, signal) }
      finally { release() }
    })().finally(() => {
      if (this.inFlight.get(key)?.promise === task) this.inFlight.delete(key)
    })
    this.inFlight.set(key, { promise: task, signal })
    return task
  }

  private acquire(signal: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      const abort = (): void => {
        const index = this.waiting.indexOf(start)
        if (index >= 0) this.waiting.splice(index, 1)
        reject(signal.reason ?? new Error('Name lookup cancelled'))
      }
      const start = (): void => {
        signal.removeEventListener('abort', abort)
        if (signal.aborted) { reject(signal.reason ?? new Error('Name lookup cancelled')); return }
        this.activeRequests += 1
        resolve(() => { this.activeRequests -= 1; this.waiting.shift()?.() })
      }
      if (signal.aborted) { abort(); return }
      if (this.activeRequests < 3) start()
      else { this.waiting.push(start); signal.addEventListener('abort', abort, { once: true }) }
    })
  }

  private async requestName(kind: 'game' | 'user', id: string, signal: AbortSignal): Promise<string | null> {
    if (!(kind === 'game' ? isStoreAppId(id) : steamIdPattern.test(id))) return null
    const url = kind === 'game'
      ? `https://store.steampowered.com/api/appdetails?appids=${id}&filters=basic&l=schinese`
      : `https://steamcommunity.com/profiles/${id}/?xml=1`
    const response = await this.fetchImpl(url, { method: 'GET', credentials: 'omit', redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]), headers: { Accept: kind === 'game' ? 'application/json' : 'application/xml' } })
    try {
      if (response.status === 429) throw new DomainError('SCREENSHOT_NAMES_RATE_LIMITED', '公开名称接口暂时限流，已保留本地名称，请稍后手动刷新')
      if (!response.ok) return null
      const text = await limitedText(response, signal)
      let name: string | null = null
      if (kind === 'game') {
        const body: unknown = JSON.parse(text)
        const item = record(body) ? body[id] : null
        const data = record(item) && item.success === true && record(item.data) ? item.data : null
        if (data && String(data.steam_appid) === id) name = cleanName(data.name)
      } else {
        const parsed: unknown = new XMLParser({ processEntities: false, parseTagValue: false, trimValues: true }).parse(text)
        const profile = record(parsed) && record(parsed.profile) ? parsed.profile : null
        if (profile && String(profile.steamID64) === id) name = cleanName(profile.steamID)
      }
      if (name && !signal.aborted) {
        const bucket = kind === 'game' ? this.cache.games : this.cache.users
        bucket[id] = { name, checkedAt: new Date(this.now()).toISOString() }
      }
      return name
    } finally { if (response.body && !response.bodyUsed && !response.body.locked) await response.body.cancel().catch(() => undefined) }
  }

  private readCache(): NameCache {
    const result = emptyCache()
    try {
      if (!existsSync(this.options.cachePath) || statSync(this.options.cachePath).size > 4 * 1024 * 1024) return result
      const input: unknown = JSON.parse(readFileSync(this.options.cachePath, 'utf8'))
      if (!record(input) || input.version !== 1) return result
      for (const kind of ['games', 'users'] as const) {
        if (!record(input[kind])) continue
        for (const [id, entry] of Object.entries(input[kind])) {
          if (!(kind === 'games' ? appIdPattern : steamIdPattern).test(id) || !record(entry)) continue
          const name = cleanName(entry.name)
          if (name && typeof entry.checkedAt === 'string' && Number.isFinite(Date.parse(entry.checkedAt))) {
            result[kind][id] = { name, checkedAt: entry.checkedAt }
          }
        }
      }
    } catch { /* Names are a disposable cache, not authoritative Steam metadata. */ }
    return result
  }

  private async saveCache(): Promise<void> {
    const temporary = `${this.options.cachePath}.${randomUUID()}.tmp`
    try {
      await mkdir(dirname(this.options.cachePath), { recursive: true })
      await writeFile(temporary, JSON.stringify(this.cache), { flag: 'wx', mode: 0o600 })
      await rename(temporary, this.options.cachePath)
    } catch { /* Offline catalog use must not depend on a writable name cache. */ }
    finally { await unlink(temporary).catch(() => undefined) }
  }
}

async function limitedText(response: Response, signal: AbortSignal): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ''
  let size = 0
  const chunks: Uint8Array[] = []
  try {
    for (;;) {
      signal.throwIfAborted()
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > 1024 * 1024) throw new Error('Screenshot name response exceeded limit')
      chunks.push(chunk.value)
    }
    return Buffer.concat(chunks, size).toString('utf8')
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
}
