import { createPublicKey, verify } from 'node:crypto'
import { TextDecoder } from 'node:util'
import { UPDATE_KEY_ID, UPDATE_PUBLIC_KEY } from '../shared/update-public-key'
import { UPDATE_REPOSITORY, type UpdateAsset, type UpdateManifest } from '../shared/update-types'

const MAX_MANIFEST_BYTES = 128 * 1024
const MAX_ASSET_BYTES = 512 * 1024 * 1024
const MAX_FUTURE_MS = 24 * 60 * 60 * 1000

export function validateVersion(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 64 || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) {
    return false
  }
  return value.split('.').every((part) => Number.isSafeInteger(Number(part)))
}

export function compareVersions(a: string, b: string): number {
  if (!validateVersion(a) || !validateVersion(b)) throw new Error('Invalid stable update version')
  const left = a.split('.').map(Number)
  const right = b.split('.').map(Number)
  for (let index = 0; index < 3; index += 1) {
    if (left[index]! < right[index]!) return -1
    if (left[index]! > right[index]!) return 1
  }
  return 0
}

export function verifySignedUpdateManifest(envelope: unknown, publicKeyBase64 = UPDATE_PUBLIC_KEY): UpdateManifest {
  const signed = requireObject(envelope, ['schema', 'keyId', 'payload', 'signature'], 'signed manifest')
  if (signed.schema !== 1 || signed.keyId !== UPDATE_KEY_ID) throw new Error('Unrecognized update signing key or schema')
  if (typeof signed.payload !== 'string' || typeof signed.signature !== 'string') throw new Error('Invalid signed manifest encoding')
  if (Buffer.byteLength(JSON.stringify(signed), 'utf8') > MAX_MANIFEST_BYTES) throw new Error('Update manifest is too large')
  const payload = decodeBase64(signed.payload, MAX_MANIFEST_BYTES, 'manifest payload')
  const signature = decodeBase64(signed.signature, 64, 'manifest signature')
  if (signature.length !== 64) throw new Error('Invalid update signature length')
  const keyBytes = decodeBase64(publicKeyBase64, 128, 'pinned public key')
  let key
  try {
    key = createPublicKey({ key: keyBytes, format: 'der', type: 'spki' })
  } catch {
    throw new Error('Invalid pinned update public key')
  }
  if (key.asymmetricKeyType !== 'ed25519' || !verify(null, payload, key, signature)) {
    throw new Error('Update manifest signature verification failed')
  }

  let decoded: unknown
  try {
    decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload))
  } catch {
    throw new Error('Invalid update manifest JSON')
  }
  return validateManifest(decoded)
}

function validateManifest(value: unknown): UpdateManifest {
  const manifest = requireObject(value, ['schema', 'repository', 'version', 'publishedAt', 'releaseUrl', 'assets'], 'manifest payload')
  if (manifest.schema !== 1 || manifest.repository !== UPDATE_REPOSITORY) throw new Error('Update manifest repository or schema mismatch')
  if (!validateVersion(manifest.version)) throw new Error('Invalid stable update version')
  if (typeof manifest.publishedAt !== 'string' || !isTimestamp(manifest.publishedAt)) throw new Error('Invalid update publication time')
  const releaseUrl = `https://github.com/${UPDATE_REPOSITORY}/releases/tag/v${manifest.version}`
  if (manifest.releaseUrl !== releaseUrl) throw new Error('Invalid update release URL')
  if (!Array.isArray(manifest.assets) || manifest.assets.length !== 2) throw new Error('Update manifest must contain both package kinds')
  const assets = manifest.assets.map((asset) => validateAsset(asset, manifest.version as string))
  if (new Set(assets.map((asset) => asset.kind)).size !== 2) throw new Error('Duplicate update package kind')
  return {
    schema: 1,
    repository: UPDATE_REPOSITORY,
    version: manifest.version,
    publishedAt: manifest.publishedAt,
    releaseUrl,
    assets
  }
}

function validateAsset(value: unknown, version: string): UpdateAsset {
  const asset = requireObject(value, ['kind', 'fileName', 'size', 'sha256', 'downloadUrl'], 'manifest asset')
  if (asset.kind !== 'setup' && asset.kind !== 'portable') throw new Error('Invalid update package kind')
  const fileName = `XiaoLan-Steam-Toolbox-${asset.kind === 'setup' ? 'Setup' : 'Portable'}-${version}-x64.exe`
  const downloadUrl = `https://github.com/${UPDATE_REPOSITORY}/releases/download/v${version}/${fileName}`
  if (asset.fileName !== fileName || asset.downloadUrl !== downloadUrl) throw new Error('Invalid update package filename or URL')
  if (typeof asset.size !== 'number' || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_ASSET_BYTES) {
    throw new Error('Invalid update package size')
  }
  if (typeof asset.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error('Invalid update package SHA-256')
  return { kind: asset.kind, fileName, size: asset.size, sha256: asset.sha256, downloadUrl }
}

function isTimestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return false
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp) || timestamp > Date.now() + MAX_FUTURE_MS) return false
  const canonical = value.includes('.') ? value : value.replace('Z', '.000Z')
  return new Date(timestamp).toISOString() === canonical
}

function decodeBase64(value: string, maxBytes: number, label: string): Buffer {
  if (value.length === 0 || value.length > Math.ceil(maxBytes / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error(`Invalid ${label} encoding`)
  }
  const decoded = Buffer.from(value, 'base64')
  if (decoded.length > maxBytes || decoded.toString('base64') !== value) throw new Error(`Invalid ${label} encoding`)
  return decoded
}

function requireObject(value: unknown, fields: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${label}`)
  const object = value as Record<string, unknown>
  const keys = Object.keys(object)
  if (keys.length !== fields.length || fields.some((field) => !Object.prototype.hasOwnProperty.call(object, field))) {
    throw new Error(`Invalid ${label} fields`)
  }
  return object
}
