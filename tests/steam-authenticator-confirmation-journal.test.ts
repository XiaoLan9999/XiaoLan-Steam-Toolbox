import { createHash } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SteamAuthenticatorConfirmationSafetyJournal } from '../src/main/steam-authenticator-confirmation-journal'
import { EncryptedAuthenticatorStateStore } from '../src/main/steam-authenticator'
import type { SecretCipher } from '../src/main/store'

const directories: Array<{ directory: string; temporary: string }> = []
const A = createHash('sha256').update('synthetic-pair-a').digest('hex'), B = createHash('sha256').update('synthetic-pair-b').digest('hex')
const DAY = 24 * 60 * 60 * 1000, PRIVATE = 'PRIVATE_STORAGE_FAILURE_NEVER_RENDER'
async function fixture(capacity?: number) {
  const temporary = await realpath(tmpdir()), directory = await realpath(await mkdtemp(join(temporary, 'xiaolan-confirmation-journal-')))
  directories.push({ temporary, directory })
  let now = 1000000
  const cipher = { isAvailable: vi.fn(() => true), backend: () => 'synthetic-test-only', encrypt: vi.fn((value: string) => Buffer.from(`synthetic:${value}`)),
    decrypt: vi.fn((value: Buffer) => { const source = value.toString('utf8'); if (!source.startsWith('synthetic:')) throw new Error(PRIVATE); return source.slice(10) }) } satisfies SecretCipher
  const path = join(directory, 'safety.json')
  const open = () => new SteamAuthenticatorConfirmationSafetyJournal({ path, cipher, capacity, now: () => now })
  const state = () => new EncryptedAuthenticatorStateStore(path, cipher).read()
  return { path, cipher, open, state, advance(ms: number) { now += ms } }
}
afterEach(async () => {
  for (const { directory, temporary } of directories.splice(0)) {
    if (dirname(directory) !== temporary || !basename(directory).startsWith('xiaolan-confirmation-journal-') || await realpath(directory) !== directory) throw new Error('Unsafe synthetic cleanup')
    await rm(directory, { recursive: true, force: true })
  }
})

describe('encrypted confirmation crash reservations, single Main writer', () => {
  it('has no automatic confirmation, polling or mutable work and creates no file during a read of an empty journal', async () => {
    const f = await fixture(), journal = f.open()
    expect(await journal.has(A)).toBe(false)
    await expect(readFile(f.path)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(f.cipher.encrypt).not.toHaveBeenCalled()
  })

  it('durably reserves before returning true and blocks the same pair after construction of a replacement service', async () => {
    const f = await fixture(), journal = f.open()
    expect(await journal.reserve(A)).toBe(true)
    expect(await f.state()).toEqual({ schema: 1, entries: [{ hash: A, at: 1000000, status: 'unknown' }] })
    const restarted = f.open()
    expect(await restarted.has(A)).toBe(true); expect(await restarted.reserve(A)).toBe(false)
    const stored = await readFile(f.path, 'utf8')
    expect(stored).not.toContain(A); expect(stored).not.toContain('unknown')
  })

  it('serializes concurrent reservations within the one shared Main journal instance', async () => {
    const f = await fixture(), journal = f.open()
    expect(await Promise.all([journal.reserve(A), journal.reserve(A)])).toEqual([true, false])
    expect(await f.state()).toMatchObject({ entries: [{ hash: A }] })
  })

  it('retains unknown results without a time-based release, including across a restart', async () => {
    const f = await fixture(), journal = f.open()
    await journal.reserve(A); await journal.finish(A, 'unknown'); f.advance(10000 * DAY)
    expect(await journal.has(A)).toBe(true); expect(await f.open().reserve(A)).toBe(false)
    expect(f.cipher.encrypt).toHaveBeenCalledOnce()
  })

  it('keeps accepted reservations for seven days and can reclaim only those expired rows', async () => {
    const f = await fixture(1), journal = f.open()
    await journal.reserve(A); await journal.finish(A, 'accepted'); f.advance(7 * DAY - 1)
    expect(await journal.has(A)).toBe(true)
    await expect(journal.reserve(B)).rejects.toMatchObject({ code: 'AUTH_CONFIRMATION_SAFETY_UNAVAILABLE' })
    f.advance(1); expect(await journal.has(A)).toBe(false); expect(await journal.reserve(B)).toBe(true)
    expect(await f.state()).toEqual({ schema: 1, entries: [{ hash: B, at: 1000000 + 7 * DAY, status: 'unknown' }] })
  })

  it('does not expire accepted reservations after the clock moves backwards', async () => {
    const f = await fixture(), journal = f.open()
    await journal.reserve(A); await journal.finish(A, 'accepted'); f.advance(-999999)
    expect(await journal.has(A)).toBe(true); expect(await journal.reserve(A)).toBe(false)
  })

  it('releases only an explicitly rejected or proven-undispatched reservation', async () => {
    const f = await fixture(), journal = f.open()
    await journal.reserve(A); await journal.finish(A, 'rejected')
    expect(await journal.has(A)).toBe(false); expect(await f.open().has(A)).toBe(false)
    expect(await journal.reserve(A)).toBe(true)
  })

  it('fails closed at capacity without evicting an unknown pair', async () => {
    const f = await fixture(1), journal = f.open(); await journal.reserve(A); f.advance(10000 * DAY)
    await expect(journal.reserve(B)).rejects.toMatchObject({ code: 'AUTH_CONFIRMATION_SAFETY_UNAVAILABLE' })
    expect(await journal.has(A)).toBe(true); expect(await journal.has(B)).toBe(false)
    expect(await f.state()).toMatchObject({ entries: [{ hash: A, status: 'unknown' }] })
  })

  it('never manufactures an accepted or unknown record without a prior durable reservation', async () => {
    const f = await fixture(), journal = f.open()
    await expect(journal.finish(A, 'accepted')).rejects.toMatchObject({ code: 'AUTH_CONFIRMATION_SAFETY_UNAVAILABLE' })
    await expect(journal.finish(A, 'unknown')).rejects.toMatchObject({ code: 'AUTH_CONFIRMATION_SAFETY_UNAVAILABLE' })
    expect(await journal.has(A)).toBe(false)
  })

  it('keeps a durable unknown reservation when updating its final status fails', async () => {
    const f = await fixture(), journal = f.open(); await journal.reserve(A)
    f.cipher.encrypt.mockImplementationOnce(() => { throw new Error(PRIVATE) })
    await expect(journal.finish(A, 'accepted')).rejects.toMatchObject({ code: 'AUTH_CONFIRMATION_SAFETY_UNAVAILABLE', message: 'AUTH_CONFIRMATION_SAFETY_UNAVAILABLE' })
    await expect(journal.has(A)).rejects.toMatchObject({ code: 'AUTH_CONFIRMATION_SAFETY_UNAVAILABLE' })
    expect(await f.open().has(A)).toBe(true)
    expect(await f.state()).toMatchObject({ entries: [{ hash: A, status: 'unknown' }] })
  })

  it('poisons this writer after a failed initial reservation instead of permitting an in-memory fallback', async () => {
    const f = await fixture(), journal = f.open(); await journal.has(A)
    f.cipher.encrypt.mockImplementationOnce(() => { throw new Error(PRIVATE) })
    await expect(journal.reserve(A)).rejects.toMatchObject({ code: 'AUTH_CONFIRMATION_SAFETY_UNAVAILABLE' })
    await expect(journal.reserve(B)).rejects.toMatchObject({ code: 'AUTH_CONFIRMATION_SAFETY_UNAVAILABLE' })
    await expect(readFile(f.path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each([
    { schema: 2, entries: [] }, { schema: 1, entries: [{ hash: A, at: 1, status: 'rejected' }] },
    { schema: 1, entries: [{ hash: A, at: 1, status: 'unknown', nonce: PRIVATE }] },
    { schema: 1, entries: [{ hash: A, at: 1, status: 'unknown' }, { hash: A, at: 2, status: 'accepted' }] },
    { schema: 1, entries: [{ hash: A, at: -1, status: 'unknown' }] }
  ])('does not overwrite invalid decrypted journal content', async malformed => {
    const f = await fixture(); await new EncryptedAuthenticatorStateStore(f.path, f.cipher).write(malformed)
    const before = await readFile(f.path), journal = f.open()
    await expect(journal.has(A)).rejects.toMatchObject({ code: 'AUTH_CONFIRMATION_SAFETY_UNAVAILABLE' })
    await expect(journal.reserve(B)).rejects.toMatchObject({ code: 'AUTH_CONFIRMATION_SAFETY_UNAVAILABLE' })
    expect(await readFile(f.path)).toEqual(before)
  })

  it('does not overwrite corrupted encrypted bytes', async () => {
    const f = await fixture(); await writeFile(f.path, 'synthetic-corrupt-bytes')
    const before = await readFile(f.path), journal = f.open()
    await expect(journal.reserve(A)).rejects.toMatchObject({ code: 'AUTH_CONFIRMATION_SAFETY_UNAVAILABLE' })
    expect(await readFile(f.path)).toEqual(before)
  })

  it('detects an external replacement using the encrypted store proof and never clobbers it', async () => {
    const f = await fixture(), journal = f.open(); expect(await journal.has(A)).toBe(false)
    await writeFile(f.path, 'synthetic-external-replacement')
    await expect(journal.reserve(A)).rejects.toMatchObject({ code: 'AUTH_CONFIRMATION_SAFETY_UNAVAILABLE' })
    expect(await readFile(f.path, 'utf8')).toBe('synthetic-external-replacement')
  })

  it('can load the maximum bounded journal within the generic encrypted-state size limit', async () => {
    const f = await fixture()
    const entries = Array.from({ length: 1024 }, (_, index) => ({ hash: createHash('sha256').update(`fixture-${index}`).digest('hex'), at: 1000000, status: 'unknown' }))
    await new EncryptedAuthenticatorStateStore(f.path, f.cipher).write({ schema: 1, entries })
    const journal = f.open(); expect(await journal.has(entries[0]!.hash)).toBe(true)
    await expect(journal.reserve(B)).rejects.toMatchObject({ code: 'AUTH_CONFIRMATION_SAFETY_UNAVAILABLE' })
  })

  it.each(['', 'raw-nonce', A.toUpperCase(), '0'.repeat(63)])('rejects nonhash input without writing it: %s', async invalid => {
    const f = await fixture(), journal = f.open()
    await expect(journal.reserve(invalid)).rejects.toMatchObject({ code: 'AUTH_CONFIRMATION_SAFETY_UNAVAILABLE' })
    expect(f.cipher.encrypt).not.toHaveBeenCalled()
  })
})
