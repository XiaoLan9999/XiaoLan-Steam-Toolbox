import { spawnSync } from 'node:child_process'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'))
const candidates = process.argv.includes('--candidates')
const unknownArguments = process.argv.slice(2).filter((value) => value !== '--candidates')
const issues = []
const maxFileBytes = 2 * 1024 * 1024

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
      const fixture = file.startsWith('tests/') && /^7656119800\d{7}$/.test(match[0])
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
