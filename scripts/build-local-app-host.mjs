import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { checkRichPresenceContract } from './generate-rich-presence-contract.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export function inspectLocalAppHost(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 256 || bytes.length > 2 * 1024 * 1024 || bytes.readUInt16LE(0) !== 0x5a4d) throw new Error('Invalid local app host binary')
  const pe = bytes.readUInt32LE(0x3c)
  if (pe < 64 || pe > bytes.length - 26 || bytes.readUInt32LE(pe) !== 0x4550 || bytes.readUInt16LE(pe + 4) !== 0x8664 || bytes.readUInt16LE(pe + 24) !== 0x20b) throw new Error('Local app host requires an x64 image')
  return { architecture: 'x64', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), fileName: 'local-app-host-x64.exe' }
}
export function localAppHostBuildPlan({ root = projectRoot, platform = process.platform, windowsDirectory = process.env.WINDIR || 'C:\\Windows', compiler, outputDirectory = join(root, 'resources', 'local-app-simulation') } = {}) {
  if (platform !== 'win32') throw new Error('Building local app host requires Windows .NET Framework 4')
  if (![root, windowsDirectory, outputDirectory].every(isAbsolute)) throw new Error('Local app host build paths must be absolute')
  const candidates = [join(windowsDirectory, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'), join(windowsDirectory, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe')]
  const executable = compiler || candidates.find(existsSync)
  if (!executable || !isAbsolute(executable)) throw new Error('Windows .NET Framework 4 C# compiler not found')
  return { root, compiler: executable, source: join(root, 'scripts', 'local-app-host.cs'), contractSource: join(root, 'scripts', 'rich-presence-contract.generated.cs'), profileSource: join(root, 'scripts', 'steam-public-interface-profiles.cs'), outputDirectory, fileName: 'local-app-host-x64.exe' }
}
export function buildLocalAppHost(options = {}) {
  const { run = spawnSync, ...planOptions } = options; const plan = localAppHostBuildPlan(planOptions)
  checkRichPresenceContract(plan.root)
  for (const path of [plan.source, plan.contractSource, plan.profileSource, plan.compiler]) if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error('Local app host build inputs must be regular files')
  mkdirSync(plan.outputDirectory, { recursive: true }); const temporary = join(plan.outputDirectory, `host-${randomBytes(12).toString('hex')}.tmp.exe`)
  try {
    const result = run(plan.compiler, ['/nologo', '/platform:x64', '/target:exe', '/optimize+', '/debug-', '/warnaserror+', `/out:${temporary}`, plan.source, plan.contractSource, plan.profileSource], { cwd: plan.root, windowsHide: true, encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024 })
    if (result.error || result.status !== 0) throw new Error('Local app host compilation failed')
    if (!lstatSync(temporary).isFile() || lstatSync(temporary).isSymbolicLink()) throw new Error('Local app host compiler output must be a regular file')
    const metadata = inspectLocalAppHost(readFileSync(temporary)); renameSync(temporary, join(plan.outputDirectory, plan.fileName)); return metadata
  } finally { try { unlinkSync(temporary) } catch (error) { if (error?.code !== 'ENOENT') throw error } }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length !== 2) throw new Error('Local app host build does not accept arguments')
  const host = buildLocalAppHost(); console.log(`Local app host ${host.architecture}: ${host.bytes} bytes, sha256 ${host.sha256}`)
}
