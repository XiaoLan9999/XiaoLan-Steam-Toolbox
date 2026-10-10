import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { ArtworkError, inspectStaticArtwork, MAX_ARTWORK_FILE_BYTES } from '../shared/artwork'
import type { ArtworkBrowserState } from '../shared/artwork-browser'
import { DomainError } from '../shared/domain'
import type { ArtworkBrowser } from './artwork-browser'

interface ArtworkUploadOptions {
  directory: string
  browser: () => Pick<ArtworkBrowser, 'open' | 'prepareUploadFile' | 'getState'>
  isAccountCurrent: (accountId: string) => boolean
}

export class ArtworkUploadService {
  private generation = 0
  private pending: Promise<void> = Promise.resolve()
  private readonly directories = new Set<string>()
  private directory: string

  constructor(private readonly options: ArtworkUploadOptions) {
    this.directory = resolve(options.directory)
  }

  prepare(accountId: string, draft: unknown): Promise<ArtworkBrowserState> {
    if (!this.options.isAccountCurrent(accountId)) return Promise.reject(uploadError('ARTWORK_NOT_AUTHENTICATED'))
    let image: { fileName: string; bytes: Buffer }
    try { image = validateDraft(draft) }
    catch (error) { return Promise.reject(error) }
    this.invalidate()
    const generation = this.generation
    const previous = this.pending
    const operation = (async (): Promise<ArtworkBrowserState> => {
      await previous
      this.assertCurrent(accountId, generation)
      let temporary: string | null = null
      try {
        mkdirSync(this.directory, { recursive: true })
        if (lstatSync(this.directory).isSymbolicLink()) {
          throw uploadError('ARTWORK_UPLOAD_PREPARE_FAILED')
        }
        this.directory = realpathSync(this.directory)
        temporary = mkdtempSync(join(this.directory, 'upload-'))
        this.directories.add(temporary)
        const filePath = join(temporary, image.fileName)
        writeFileSync(filePath, image.bytes, { flag: 'wx', mode: 0o600 })
        this.assertCurrent(accountId, generation)
        const browser = this.options.browser()
        await browser.open('upload', accountId, { reload: true })
        this.assertCurrent(accountId, generation)
        await browser.prepareUploadFile(accountId, filePath)
        this.assertCurrent(accountId, generation)
        const state = browser.getState()
        if (state.tool !== 'upload' || state.accountId !== accountId || state.phase !== 'ready') {
          throw uploadError('ARTWORK_SESSION_CHANGED')
        }
        return state
      } catch (error) {
        if (temporary) this.removeDirectory(temporary)
        if (error instanceof DomainError) throw error
        throw uploadError('ARTWORK_UPLOAD_PREPARE_FAILED')
      }
    })()
    this.pending = operation.then(() => undefined, () => undefined)
    return operation
  }

  invalidate(): void {
    this.generation += 1
    for (const directory of this.directories) this.removeDirectory(directory)
  }

  private assertCurrent(accountId: string, generation: number): void {
    if (generation !== this.generation || !this.options.isAccountCurrent(accountId)) {
      throw uploadError('ARTWORK_SESSION_CHANGED')
    }
  }

  private removeDirectory(directory: string): void {
    const child = relative(this.directory, resolve(directory))
    if (!this.directories.has(directory) || !child || child.startsWith(`..${sep}`) ||
        child === '..' || isAbsolute(child) || !/^upload-[^/\\]+$/.test(child)) return
    try {
      const base = lstatSync(this.directory)
      const target = lstatSync(directory)
      if (!base.isDirectory() || base.isSymbolicLink() || !target.isDirectory() || target.isSymbolicLink() ||
          realpathSync(this.directory) !== this.directory || realpathSync(directory) !== resolve(directory)) return
      // Only directories created by this instance are eligible for recursive removal.
      rmSync(directory, { recursive: true, force: true })
      this.directories.delete(directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') this.directories.delete(directory)
      // An open Chromium file handle can delay cleanup until the next invalidation.
    }
  }
}

function validateDraft(draft: unknown): { fileName: string; bytes: Buffer } {
  if (!draft || typeof draft !== 'object') throw uploadError('ARTWORK_INVALID_UPLOAD')
  const { name, base64 } = draft as Record<string, unknown>
  if (typeof name !== 'string' || !name.trim() || name.length > 256 ||
      typeof base64 !== 'string' || !base64 || base64.length % 4 !== 0) {
    throw uploadError('ARTWORK_INVALID_UPLOAD')
  }
  if (base64.length > Math.ceil(MAX_ARTWORK_FILE_BYTES / 3) * 4) throw uploadError('ARTWORK_UPLOAD_TOO_LARGE')
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    throw uploadError('ARTWORK_INVALID_UPLOAD')
  }
  const bytes = Buffer.from(base64, 'base64')
  if (bytes.toString('base64') !== base64) throw uploadError('ARTWORK_INVALID_UPLOAD')
  try {
    if (inspectStaticArtwork(bytes).format !== 'png') throw uploadError('ARTWORK_UPLOAD_INVALID_IMAGE')
  } catch (error) {
    if (error instanceof ArtworkError && error.code === 'fileTooLarge') throw uploadError('ARTWORK_UPLOAD_TOO_LARGE')
    throw uploadError('ARTWORK_UPLOAD_INVALID_IMAGE')
  }
  const stem = name.replace(/\.png$/i, '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[.\s]+$/g, '').trim().slice(0, 100)
  return { fileName: `artwork-${stem || 'image'}.png`, bytes }
}

function uploadError(code: string): DomainError {
  return new DomainError(code, code)
}
