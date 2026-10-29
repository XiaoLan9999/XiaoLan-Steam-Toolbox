import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SqliteStore, type SecretCipher } from '../src/main/store'

const temporary = realpathSync(tmpdir())
const resources: Array<{ directory: string; stores: SqliteStore[] }> = []
const cipher: SecretCipher = { isAvailable: () => false, backend: () => 'synthetic-test',
  encrypt: value => Buffer.from(value), decrypt: value => value.toString() }
function fixture() {
  const directory = realpathSync(mkdtempSync(join(temporary, 'xiaolan-energy-store-')))
  const stores: SqliteStore[] = []
  const open = (name = 'synthetic.sqlite3') => {
    const store = new SqliteStore(join(directory, name), cipher)
    stores.push(store)
    return store
  }
  resources.push({ directory, stores })
  return { directory, stores, open }
}
afterEach(() => {
  for (const resource of resources.splice(0)) {
    for (const store of resource.stores) store.close()
    if (dirname(resource.directory) !== temporary || !basename(resource.directory).startsWith('xiaolan-energy-store-')) throw new Error('Unsafe energy fixture cleanup')
    rmSync(resource.directory, { recursive: true, force: true })
  }
})

describe('background energy preference', () => {
  it('defaults existing and new databases to enabled and persists a disabled preference across reopening', () => {
    const f = fixture()
    const store = f.open()
    expect(store.getEnergySavingEnabled()).toBe(true)
    store.setEnergySavingEnabled(false)
    expect(store.getEnergySavingEnabled()).toBe(false)
    store.close()
    f.stores.splice(0)
    const reopened = f.open()
    expect(reopened.getEnergySavingEnabled()).toBe(false)
    reopened.setEnergySavingEnabled(true)
    expect(reopened.getEnergySavingEnabled()).toBe(true)
  })

  it.each([null, undefined, 'false', 0, 1, {}, []])('rejects a malformed preference without altering the saved value %#', value => {
    const store = fixture().open()
    store.setEnergySavingEnabled(false)
    expect(() => store.setEnergySavingEnabled(value as boolean)).toThrow()
    expect(store.getEnergySavingEnabled()).toBe(false)
  })

  it('preserves the reviewed boolean preference in a validated standalone database import', async () => {
    const f = fixture()
    const source = f.open()
    source.setEnergySavingEnabled(false)
    await source.exportDatabase(join(f.directory, 'backup.sqlite3'))
    source.close()
    f.stores.splice(0)
    SqliteStore.createImportedDatabase(join(f.directory, 'backup.sqlite3'), join(f.directory, 'imported.sqlite3'))
    expect(f.open('imported.sqlite3').getEnergySavingEnabled()).toBe(false)
  })
})
