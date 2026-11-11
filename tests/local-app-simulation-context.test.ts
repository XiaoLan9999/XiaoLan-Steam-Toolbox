import { describe, expect, it, vi } from 'vitest'
import { buildLocalAppSimulationMonitorScript, readLocalAppSimulationMonitorContext, type LocalAppSimulationContext } from '../src/main/local-app-simulation-context'

const ownerPid = 2222
const context = (): LocalAppSimulationContext => ({
  steamId: '76561198000000001', appId: 730, steamPid: 1111, steamStartTicks: '638001234567890123',
  steamExe: 'D:\\Steam\\steam.exe', activeAppIds: [], ownerPid, ownerStartTicks: '638001234567890456'
})
const dependencies = (value: unknown = context()) => ({
  platform: 'win32' as const, ownerPid, windowsDirectory: 'C:\\Windows',
  execute: vi.fn(async () => ({ stdout: JSON.stringify(value) })),
  realpath: vi.fn(async () => 'D:\\CanonicalSteam\\steam.exe')
})

describe('local simulation lightweight monitor context', () => {
  it('reads live process identity with Get-Process.Path without CIM, Apps enumeration or commands that write state', () => {
    const script = buildLocalAppSimulationMonitorScript(ownerPid)
    expect(script).toContain("'HKCU:\\Software\\Valve\\Steam\\ActiveProcess'")
    expect(script).toContain('$steam=Get-Process -Id ([int]$active.pid)')
    expect(script).toContain(`$owner=Get-Process -Id ${ownerPid}`)
    expect(script).toContain('$image=[string]$steam.Path')
    expect(script).toContain('$config.SteamExe')
    expect(script).toContain('[StringComparison]::OrdinalIgnoreCase')
    expect(script).toContain('$steam.StartTime.ToUniversalTime().Ticks.ToString()')
    expect(script).toContain('$owner.StartTime.ToUniversalTime().Ticks.ToString()')
    expect(script).toContain('$config.RunningAppID')
    expect(script).toContain('$active.ActiveUser')
    expect(script).toContain('activeAppIds=@()')
    expect(script).not.toMatch(/CimInstance|Win32_Process|Get-ChildItem|Steam\\Apps|Set-Item|Remove-Item|Start-Process|Stop-Process/)
  })

  it.each([0, -1, 1.5, NaN, Infinity, 0x100000000, '2222; malicious'])('rejects invalid owner process input %s before launching a process', async value => {
    const deps = dependencies()
    await expect(readLocalAppSimulationMonitorContext({ ...deps, ownerPid: value as number })).rejects.toThrow('Invalid local app monitor owner')
    expect(deps.execute).not.toHaveBeenCalled()
    expect(deps.realpath).not.toHaveBeenCalled()
  })

  it('uses a hidden, bounded PowerShell process with encoded arguments and validates the canonical image path', async () => {
    const deps = dependencies()
    expect(await readLocalAppSimulationMonitorContext(deps)).toEqual({ ...context(), steamExe: 'D:\\CanonicalSteam\\steam.exe' })
    expect(deps.execute).toHaveBeenCalledTimes(1)
    const [executable, args, options] = deps.execute.mock.calls[0] as unknown as [string, string[], unknown]
    expect(executable.toLowerCase()).toBe('c:\\windows\\system32\\windowspowershell\\v1.0\\powershell.exe')
    expect(args.slice(0, 4)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand'])
    expect(Buffer.from(args[4]!, 'base64').toString('utf16le')).toBe(buildLocalAppSimulationMonitorScript(ownerPid))
    expect(options).toEqual({ windowsHide: true, timeout: 10000, maxBuffer: 65536, encoding: 'utf8' })
    expect(deps.realpath).toHaveBeenCalledWith('D:\\Steam\\steam.exe')
  })

  it('does not cache a successful identity and observes the next account and Steam process change', async () => {
    const deps = dependencies()
    const next = { ...context(), steamId: '76561198000000002', steamPid: 1112, steamStartTicks: '638001234567899999' }
    deps.execute.mockResolvedValueOnce({ stdout: JSON.stringify(context()) }).mockResolvedValueOnce({ stdout: JSON.stringify(next) })
    expect((await readLocalAppSimulationMonitorContext(deps)).steamId).toBe(context().steamId)
    expect(await readLocalAppSimulationMonitorContext(deps)).toMatchObject({ ...next, steamExe: 'D:\\CanonicalSteam\\steam.exe' })
    expect(deps.execute).toHaveBeenCalledTimes(2)
    expect(deps.realpath).toHaveBeenCalledTimes(2)
  })

  it('rejects unsupported platforms without a process launch', async () => {
    const deps = dependencies()
    await expect(readLocalAppSimulationMonitorContext({ ...deps, platform: 'linux' })).rejects.toThrow('requires Windows')
    expect(deps.execute).not.toHaveBeenCalled()
  })

  it.each([
    { ownerPid: ownerPid + 1 }, { steamPid: ownerPid }, { steamPid: 0 }, { steamId: 'invalid' },
    { steamStartTicks: '0' }, { ownerStartTicks: 'invalid' }, { appId: -1 }, { appId: 0x1000000 },
    { steamExe: 'relative/steam.exe' }, { steamExe: 'D:\\Steam\\not-steam.exe' }, { activeAppIds: [730] }, { activeAppIds: undefined }
  ])('rejects malformed or unexpected live identity fields %j', async patch => {
    const deps = dependencies({ ...context(), ...patch })
    await expect(readLocalAppSimulationMonitorContext(deps)).rejects.toThrow('Local app context unavailable')
    expect(deps.realpath).not.toHaveBeenCalled()
  })

  it('rejects invalid JSON, oversized output, inaccessible processes and unresolved image paths', async () => {
    const deps = dependencies()
    deps.execute.mockResolvedValueOnce({ stdout: 'not JSON' })
    await expect(readLocalAppSimulationMonitorContext(deps)).rejects.toThrow()
    deps.execute.mockResolvedValueOnce({ stdout: ' '.repeat(65537) })
    await expect(readLocalAppSimulationMonitorContext(deps)).rejects.toThrow('Local app context unavailable')
    deps.execute.mockRejectedValueOnce(new Error('Process identity unavailable'))
    await expect(readLocalAppSimulationMonitorContext(deps)).rejects.toThrow('Process identity unavailable')
    deps.realpath.mockRejectedValueOnce(new Error('Path unavailable'))
    await expect(readLocalAppSimulationMonitorContext(deps)).rejects.toThrow('Path unavailable')
  })

  it.each(['steam.exe', 'D:\\Steam\\wrong.exe'])('rejects an unsuitable canonical image path %s', async path => {
    const deps = dependencies()
    deps.realpath.mockResolvedValue(path)
    await expect(readLocalAppSimulationMonitorContext(deps)).rejects.toThrow('Local app context unavailable')
  })

  it('accepts an idle Steam process and BOM-prefixed output without inventing active game ids', async () => {
    const deps = dependencies()
    deps.execute.mockResolvedValue({ stdout: `\uFEFF${JSON.stringify({ ...context(), appId: 0 })}\n` })
    expect(await readLocalAppSimulationMonitorContext(deps)).toMatchObject({ appId: 0, activeAppIds: [] })
  })
})
