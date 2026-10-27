import { spawnSync } from 'node:child_process'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'))
const candidates = process.argv.includes('--candidates')
const unknownArguments = process.argv.slice(2).filter((value) => value !== '--candidates')
const issues = []
const maxFileBytes = 2 * 1024 * 1024
const reviewedImageAssets = new Set(['build/icon.png', 'build/icon.ico', 'src/renderer/src/assets/app-logo.png'])
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const iconSizes = new Set([16, 24, 32, 48, 64, 128, 256])
const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1
  return value >>> 0
})

function pngDimensions(bytes) {
  if (bytes.length < 57 || !bytes.subarray(0, 8).equals(pngSignature)) throw new Error('invalid PNG signature')
  let dimensions
  let hasPixels = false
  let ended = false
  const ancillaryLengths = { sRGB: [1], gAMA: [4], cHRM: [32], pHYs: [9], bKGD: [6], sBIT: [3, 4], tRNS: [6] }
  for (let offset = 8; offset < bytes.length;) {
    if (offset + 12 > bytes.length) throw new Error('truncated PNG chunk')
    const length = bytes.readUInt32BE(offset)
    const end = offset + length + 12
    if (end > bytes.length) throw new Error('truncated PNG payload')
    const type = bytes.toString('ascii', offset + 4, offset + 8)
    let crc = 0xffffffff
    for (const byte of bytes.subarray(offset + 4, end - 4)) crc = crcTable[(crc ^ byte) & 255] ^ crc >>> 8
    if (((crc ^ 0xffffffff) >>> 0) !== bytes.readUInt32BE(end - 4)) throw new Error('invalid PNG checksum')
    if (type === 'IHDR') {
      if (offset !== 8 || dimensions || length !== 13) throw new Error('invalid PNG image header')
      const data = bytes.subarray(offset + 8, end - 4)
      const width = data.readUInt32BE(0), height = data.readUInt32BE(4)
      if (!width || width !== height || width > 2048 || data[8] !== 8 || ![2, 6].includes(data[9]) ||
        data[10] !== 0 || data[11] !== 0 || data[12] !== 0) throw new Error('unsupported PNG image layout')
      dimensions = { width, height }
    } else if (!dimensions) throw new Error('missing PNG image header')
    else if (type === 'IDAT') hasPixels ||= length > 0
    else if (type === 'IEND') {
      if (length !== 0 || end !== bytes.length || !hasPixels) throw new Error('invalid PNG end marker')
      ended = true
    } else if (!ancillaryLengths[type]?.includes(length)) throw new Error('PNG metadata or unsupported chunk is not allowed')
    offset = end
  }
  if (!dimensions || !ended) throw new Error('incomplete PNG image')
  return dimensions
}

function auditImageAsset(file, bytes) {
  try {
    if (file.endsWith('.png')) {
      if (pngDimensions(bytes).width < 256) throw new Error('logo PNG must be at least 256 pixels square')
      return
    }
    if (bytes.length < 22 || bytes.readUInt16LE(0) !== 0 || bytes.readUInt16LE(2) !== 1) throw new Error('invalid ICO header')
    const count = bytes.readUInt16LE(4)
    if (count < 1 || count > 8 || bytes.length < 6 + count * 16) throw new Error('invalid ICO image count')
    const ranges = []
    const sizes = new Set()
    for (let index = 0; index < count; index++) {
      const entry = 6 + index * 16
      const width = bytes[entry] || 256, height = bytes[entry + 1] || 256
      const planes = bytes.readUInt16LE(entry + 4), depth = bytes.readUInt16LE(entry + 6)
      const length = bytes.readUInt32LE(entry + 8), offset = bytes.readUInt32LE(entry + 12)
      if (!iconSizes.has(width) || width !== height || sizes.has(width) || bytes[entry + 2] || bytes[entry + 3] ||
        ![0, 1].includes(planes) || ![0, 32].includes(depth) || !length || offset < 6 + count * 16 || offset + length > bytes.length) {
        throw new Error('invalid ICO directory entry')
      }
      sizes.add(width)
      const image = bytes.subarray(offset, offset + length)
      if (image.subarray(0, 8).equals(pngSignature)) {
        if (pngDimensions(image).width !== width) throw new Error('ICO PNG dimensions do not match the directory')
      } else {
        const maskBytes = Math.ceil(width / 32) * 4 * height
        if (image.length !== 40 + width * height * 4 + maskBytes || image.readUInt32LE(0) !== 40 ||
          image.readInt32LE(4) !== width || image.readInt32LE(8) !== height * 2 || image.readUInt16LE(12) !== 1 ||
          image.readUInt16LE(14) !== 32 || image.readUInt32LE(16) !== 0 || image.readUInt32LE(32) !== 0 ||
          ![0, width * height * 4].includes(image.readUInt32LE(20))) throw new Error('unsupported ICO bitmap payload')
      }
      ranges.push({ offset, length })
    }
    let expected = 6 + count * 16
    for (const range of ranges.sort((left, right) => left.offset - right.offset)) {
      if (range.offset !== expected) throw new Error('ICO payload contains gaps or overlaps')
      expected += range.length
    }
    if (expected !== bytes.length) throw new Error('ICO contains trailing data')
  } catch (error) {
    report(file, 0, `reviewed logo asset rejected: ${error instanceof Error ? error.message : 'invalid image'}`)
  }
}

function git(args) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: null,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true
  })
  if (result.error || result.status !== 0) {
    throw new Error(`Git command failed: ${args[0]}`)
  }
  return result.stdout
}

function report(file, line, reason) {
  issues.push(`${file}${line ? `:${line}` : ''}: ${reason}`)
}

const secretRules = [
  ['private key', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/],
  ['GitHub credential', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{60,})\b/],
  ['AWS access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['Slack credential', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
  ['API credential', /\bsk-(?:proj-|svcacct-|ant-api\d{2}-)?[A-Za-z0-9_-]{32,}\b/],
  ['JWT credential', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{16,}\b/],
  ['literal bearer credential', /\bBearer\s+[A-Za-z0-9._~+/-]{24,}={0,2}\b/],
  ['Steam session cookie', /\bsessionid=[a-f0-9]{24,}\b/i],
  ['Windows user directory', /\b[A-Z]:[\\/](?:Users|Documents and Settings)[\\/][^\s\\/]+/i]
]

function auditText(file, content) {
  const lines = content.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    for (const [name, pattern] of secretRules) {
      if (pattern.test(line)) report(file, index + 1, name)
    }

    const literalSecret = line.match(/["']?(?:api[_-]?key|refresh[_-]?token|access[_-]?token|authorization)["']?\s*[:=]\s*["']([A-Za-z0-9_./+=%-]{24,})["']/i)
    if (literalSecret) {
      const fixture = file.startsWith('tests/') && /^(?:test-|synthetic-|fixture-|export-must-not-contain-)/.test(literalSecret[1])
      if (!fixture) report(file, index + 1, 'literal credential assignment')
    }

    for (const match of line.matchAll(/\b7656119\d{10}\b/g)) {
      // This range is used only by the manually generated test fixtures.
      const fixture = (file.startsWith('tests/') || file.startsWith('integrations/asf-status-copy/tests/')) &&
        /^7656119800\d{7}$/.test(match[0])
      if (!fixture) report(file, index + 1, 'Steam ID outside the reviewed synthetic test range')
    }
  }
}

function auditFile(file, mode) {
  if (isAbsolute(file) || file.split('/').some((part) => part === '..')) {
    report(file, 0, 'path outside repository')
    return
  }
  if (mode && !['100644', '100755'].includes(mode)) {
    report(file, 0, 'symlink, submodule, or unresolved index entry')
    return
  }
  if (/(?:^|\/)(?:node_modules|out|dist|data|backups?|logs?|\.git|\.vite|\.cache|\.tmp)(?:\/|$)/i.test(file) ||
      /(?:^|\/)\.env(?:\..*)?$/i.test(file) && !file.endsWith('.env.example') ||
      /\.(?:sqlite3?|db)(?:[-.].*)?$/i.test(file) ||
      /\.(?:log|bak|dmp|exe|dll|asar|zip|7z|tar|gz|pfx|p12|pem|key|tsbuildinfo)$/i.test(file) ||
      /(?:^|\/)(?:cookies?|credentials?|secrets?|tokens?)\.json$/i.test(file)) {
    report(file, 0, 'runtime data, archive, build output, or secret file')
    return
  }

  let bytes
  if (candidates) {
    const path = resolve(root, file)
    const info = lstatSync(path)
    if (!info.isFile() || info.isSymbolicLink()) {
      report(file, 0, 'candidate is not a regular file')
      return
    }
    const realPath = realpathSync(path)
    const fromRoot = relative(root, realPath)
    if (isAbsolute(fromRoot) || fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) {
      report(file, 0, 'candidate resolves outside repository')
      return
    }
    if (info.size > maxFileBytes) {
      report(file, 0, 'source file exceeds 2 MiB review limit')
      return
    }
    bytes = readFileSync(realPath)
  } else {
    bytes = git(['show', `:${file}`])
  }

  if (bytes.length > maxFileBytes) {
    report(file, 0, 'source file exceeds 2 MiB review limit')
    return
  }
  if (reviewedImageAssets.has(file)) {
    auditImageAsset(file, bytes)
    return
  }
  if (bytes.includes(0)) {
    report(file, 0, 'binary file requires explicit source review')
    return
  }
  let content
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    report(file, 0, 'source is not valid UTF-8')
    return
  }
  auditText(file, content)
}

try {
  if (unknownArguments.length) throw new Error('Usage: node scripts/audit-source.mjs [--candidates]')
  const gitRoot = realpathSync(git(['rev-parse', '--show-toplevel']).toString('utf8').trim())
  if (gitRoot !== root) throw new Error('Audit must run in this project repository')
  let files
  if (candidates) {
    const output = git(['ls-files', '--cached', '--others', '--exclude-standard', '-z']).toString('utf8')
    files = [...new Set(output.split('\0').filter(Boolean))].map((file) => ({ file }))
  } else {
    const output = git(['ls-files', '--stage', '-z']).toString('utf8')
    files = output.split('\0').filter(Boolean).map((entry) => {
      const tab = entry.indexOf('\t')
      const [mode, , stage] = entry.slice(0, tab).split(' ')
      return { file: entry.slice(tab + 1), mode: stage === '0' ? mode : 'unmerged' }
    })
  }
  if (!files.length) {
    console.error('SKIP: Git index has no source files. Stage the intended source, then run the audit again; --candidates is a working-tree preflight only.')
    process.exitCode = 2
  } else {
    for (const { file, mode } of files) auditFile(file, mode)
    if (issues.length) {
      console.error(`FAIL: ${issues.length} source audit issue(s); matched values are intentionally omitted.`)
      for (const issue of issues) console.error(issue)
      process.exitCode = 1
    } else {
      console.log(`PASS: ${files.length} ${candidates ? 'working-tree candidate' : 'Git index'} files reviewed; no runtime data or recognized credential signatures found.`)
      if (candidates) console.log('Stage the final source and rerun without --candidates before committing.')
    }
  }
} catch (error) {
  console.error(`FAIL: ${error instanceof Error ? error.message : 'Source audit failed'}`)
  process.exitCode = 1
}
