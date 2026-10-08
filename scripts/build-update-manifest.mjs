import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repository = 'XiaoLan9999/XiaoLan-Steam-Toolbox'
const maxAssetBytes = 512 * 1024 * 1024

async function main() {
  const options = parseOptions(process.argv.slice(2))
  const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
  const version = packageJson.version
  if (!validVersion(version)) throw new Error('package.json must contain a stable semantic version')
  const expectedTag = `v${version}`
  const environmentTag = process.env.GITHUB_REF_TYPE === 'tag' || /^v\d/.test(process.env.GITHUB_REF_NAME || '')
    ? process.env.GITHUB_REF_NAME
    : undefined
  if (options.tag && options.tag !== expectedTag || environmentTag && environmentTag !== expectedTag) {
    throw new Error('Release tag must exactly match package.json version')
  }
  if (options.keyFile && process.env.UPDATE_SIGNING_PRIVATE_KEY) {
    throw new Error('Provide either UPDATE_SIGNING_PRIVATE_KEY or --key-file, not both')
  }
  const privateKeyPem = options.keyFile
    ? await readFile(resolve(process.cwd(), options.keyFile), 'utf8')
    : process.env.UPDATE_SIGNING_PRIVATE_KEY
  if (!privateKeyPem) throw new Error('Set UPDATE_SIGNING_PRIVATE_KEY or provide --key-file')
  let privateKey
  try {
    privateKey = createPrivateKey(privateKeyPem)
  } catch {
    throw new Error('Update signing private key is invalid')
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('Update signing key must use Ed25519')
  const source = await readFile(resolve(root, 'src/shared/update-public-key.ts'), 'utf8')
  const keyId = source.match(/^export const UPDATE_KEY_ID = '([^']+)'\s*$/m)?.[1]
  const publicKey = source.match(/^export const UPDATE_PUBLIC_KEY = '([A-Za-z0-9+/=]+)'\s*$/m)?.[1]
  if (!keyId || !publicKey) throw new Error('Pinned update key constants could not be read')
  const derivedKey = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).toString('base64')
  if (derivedKey !== publicKey) throw new Error('Signing key does not match the application pinned public key')

  const assets = []
  for (const kind of ['setup', 'portable']) {
    const fileName = `XiaoLan-Steam-Toolbox-${kind === 'setup' ? 'Setup' : 'Portable'}-${version}-x64.exe`
    const filePath = resolve(root, 'dist', fileName)
    const before = await lstat(filePath)
    if (!before.isFile() || before.isSymbolicLink() || before.size <= 0 || before.size > maxAssetBytes) {
      throw new Error(`Invalid release package: ${fileName}`)
    }
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(filePath)) hash.update(chunk)
    const after = await lstat(filePath)
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error(`Release package changed while hashing: ${fileName}`)
    assets.push({
      kind,
      fileName,
      size: before.size,
      sha256: hash.digest('hex'),
      downloadUrl: `https://github.com/${repository}/releases/download/${expectedTag}/${fileName}`
    })
  }
  const manifest = {
    schema: 1,
    repository,
    version,
    publishedAt: new Date().toISOString(),
    releaseUrl: `https://github.com/${repository}/releases/tag/${expectedTag}`,
    assets
  }
  const payload = Buffer.from(JSON.stringify(manifest), 'utf8')
  const envelope = {
    schema: 1,
    keyId,
    payload: payload.toString('base64'),
    signature: sign(null, payload, privateKey).toString('base64')
  }
  const manifestJson = `${JSON.stringify(envelope, null, 2)}\n`
  const manifestDigest = createHash('sha256').update(manifestJson).digest('hex')
  const checksums = [...assets.map((asset) => `${asset.sha256}  ${asset.fileName}`), `${manifestDigest}  update-manifest.json`].join('\n') + '\n'
  await atomicWrite(resolve(root, 'dist/update-manifest.json'), manifestJson)
  await atomicWrite(resolve(root, 'dist/SHA256SUMS.txt'), checksums)
  console.log(`Signed ${expectedTag}: update-manifest.json and SHA256SUMS.txt (${assets.length} packages)`)
}

function parseOptions(args) {
  const options = {}
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]
    if (flag !== '--tag' && flag !== '--key-file') throw new Error(`Unknown option: ${flag}`)
    const name = flag === '--tag' ? 'tag' : 'keyFile'
    if (options[name] || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Invalid option: ${flag}`)
    options[name] = args[++index]
  }
  return options
}

function validVersion(version) {
  return typeof version === 'string' && version.length <= 64 && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) &&
    version.split('.').every((part) => Number.isSafeInteger(Number(part)))
}

async function atomicWrite(filePath, content) {
  const temporaryPath = `${filePath}.${process.pid}.tmp`
  await writeFile(temporaryPath, content, { encoding: 'utf8', flag: 'wx' })
  await rename(temporaryPath, filePath)
}

main().catch((error) => {
  // Errors deliberately omit stack traces and key contents.
  console.error(error instanceof Error ? error.message : 'Update manifest build failed')
  process.exitCode = 1
})
