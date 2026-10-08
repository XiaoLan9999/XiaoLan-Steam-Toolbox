import { generateKeyPairSync, createPublicKey } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const directory = resolve(root, '.release-keys')
const privatePath = resolve(directory, 'update-signing-private.pem')
mkdirSync(directory, { recursive: true, mode: 0o700 })
if (!existsSync(privatePath)) {
  const pair = generateKeyPairSync('ed25519')
  writeFileSync(privatePath, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' })
}
const publicKey = createPublicKey(readFileSync(privatePath)).export({ type: 'spki', format: 'der' }).toString('base64')
console.log(JSON.stringify({ keyId: 'xiaolan-updates-2026-v1', publicKey, privateKeyStoredLocally: true }))
