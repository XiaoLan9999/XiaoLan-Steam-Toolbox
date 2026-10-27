import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { checkRichPresenceContract } from './generate-rich-presence-contract.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const architectures = Object.freeze(['x86', 'x64'])

export function inspectNativeWorker(binary, architecture) {
  if (!Buffer.isBuffer(binary) || !architectures.includes(architecture) || binary.length < 256 || binary.length > 2 * 1024 * 1024 || binary.readUInt16LE(0) !== 0x5a4d) throw new Error('Invalid native presence worker binary')
  const pe = binary.readUInt32LE(0x3c)
  if (pe < 64 || pe > binary.length - 26 || binary.readUInt32LE(pe) !== 0x4550 || binary.readUInt16LE(pe + 4) !== (architecture === 'x86' ? 0x14c : 0x8664) || binary.readUInt16LE(pe + 24) !== (architecture === 'x86' ? 0x10b : 0x20b)) throw new Error('Native presence worker architecture mismatch')
  return { architecture, bytes: binary.length, sha256: createHash('sha256').update(binary).digest('hex') }
}

export function nativePresenceBuildPlan({ root = projectRoot, platform = process.platform, windowsDirectory = process.env.WINDIR || 'C:\\Windows', compiler } = {}) {
  if (platform !== 'win32') throw new Error('Building native presence workers requires Windows .NET Framework 4')
  if (!isAbsolute(root) || !isAbsolute(windowsDirectory)) throw new Error('Native presence build paths must be absolute')
  const source = join(root, 'scripts', 'native-presence-worker.cs')
  const publicSource = join(root, 'scripts', 'native-presence-public-backend.cs')
  const profileSource = join(root, 'scripts', 'steam-public-interface-profiles.cs')
  const contractSource = join(root, 'scripts', 'rich-presence-contract.generated.cs')
  const output = join(root, 'resources', 'native-presence')
  const candidates = [join(windowsDirectory, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'), join(windowsDirectory, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe')]
  const executable = compiler || candidates.find(existsSync)
  if (!executable || !isAbsolute(executable)) throw new Error('Windows .NET Framework 4 C# compiler not found')
  return { root, source, publicSource, contractSource, profileSource, output, compiler: executable, workers: architectures.map(architecture => ({ architecture, fileName: `worker-${architecture}.exe` })) }
}

export function buildNativePresence(options = {}) {
  const { run = spawnSync, ...planOptions } = options
  const plan = nativePresenceBuildPlan(planOptions)
  checkRichPresenceContract(plan.root)
  if ([plan.source, plan.publicSource, plan.contractSource, plan.profileSource, plan.compiler].some(path => !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())) throw new Error('Native presence build inputs must be regular files')
  mkdirSync(plan.output, { recursive: true })
  const staged = []
  try {
    for (const worker of plan.workers) {
      const temporary = join(plan.output, `${worker.fileName}.${randomBytes(12).toString('hex')}.tmp.exe`)
      const item = { ...worker, temporary, destination: join(plan.output, worker.fileName) }
      staged.push(item)
      const result = run(plan.compiler, ['/nologo', `/platform:${worker.architecture}`, '/target:exe', '/optimize+', '/debug-', '/warnaserror+', `/out:${temporary}`, plan.source, plan.publicSource, plan.contractSource, plan.profileSource], { cwd: plan.root, windowsHide: true, encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024 })
      if (result.error || result.status !== 0) throw new Error(`Native presence ${worker.architecture} compilation failed`)
      if (!lstatSync(temporary).isFile() || lstatSync(temporary).isSymbolicLink()) throw new Error('Native presence compiler output must be a regular file')
      item.metadata = inspectNativeWorker(readFileSync(temporary), worker.architecture)
    }
    for (const item of staged) renameSync(item.temporary, item.destination)
    return staged.map(item => ({ ...item.metadata, fileName: item.fileName }))
  } finally {
    for (const item of staged) {
      try { unlinkSync(item.temporary) } catch (error) { if (error?.code !== 'ENOENT') throw error }
    }
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length !== 2) throw new Error('Native presence build does not accept arguments')
  for (const worker of buildNativePresence()) console.log(`Native presence worker ${worker.architecture}: ${worker.bytes} bytes, sha256 ${worker.sha256}`)
}
