import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve('integrations/asf-status-copy')
const source = (path: string): string => readFileSync(resolve(root, path), 'utf8')
const codec = source('src/RichPresenceCodec.cs')
const plugin = source('src/Plugin.cs')
const transport = source('src/RichPresenceTransport.cs')

describe('safe ASF companion source and package boundaries', () => {
  it('contains only the generic plugin source files, not a copied configuration or observation', () => {
    expect(readdirSync(resolve(root, 'src')).sort()).toEqual(['ASFStatusRelay.csproj', 'Plugin.cs', 'RelayConfiguration.cs', 'RelaySession.cs', 'RelaySettings.cs', 'RichPresenceCodec.cs', 'RichPresenceTransport.cs'])
    for (const name of readdirSync(resolve(root, 'src'))) expect(source(`src/${name}`)).not.toMatch(/7656119\d{10}|https?:\/\/(?!example\.)/)
    expect(readdirSync(resolve(root, 'tests')).sort()).toEqual(['ASFStatusRelay.SelfTests.csproj', 'Program.cs'])
  })

  it('uses an explicit native public-key allowlist instead of an incomplete exclusion list', () => {
    const declaration = /HashSet<string> PublicKeys[\s\S]*?\{([\s\S]*?)\};/.exec(codec)![1]!
    expect([...declaration.matchAll(/"([^"]+)"/g)].map(match => match[1])).toEqual(['desc', 'status', 'activity', 'details', 'version', 'state', 'currentmap', 'map', 'mode', 'score', 'matchgrouploc', 'game:state', 'game:mode', 'game:map', 'game:act', 'game:score'])
    expect(declaration).not.toMatch(/connect|server|room|session|token|steam_player_group|url/)
    expect(codec).not.toContain('ExcludedKeys')
    expect(codec).toContain('!PublicKeys.Contains(normalized)')
    expect(codec).toContain('SafeValue(value)')
    expect(codec).toContain('StrictUtf8.GetByteCount(value) > 255')
    expect(codec).toContain('char.IsControl(c)')
    expect(codec).toContain('DisplayToken.IsMatch(value)')
  })

  it('enforces filtering at both the source read and final upload encoding boundary', () => {
    expect(transport).toContain('RichPresenceCodec.Sanitize(values)')
    expect(transport).toContain('RichPresenceCodec.Encode(values)')
    expect(codec).toMatch(/public static byte\[\] Encode[\s\S]*?foreach \(\(string key, string value\) in Sanitize\(values\)\)/)
    expect(codec).toContain('RegexMatchTimeoutException')
    expect(codec).toContain('EncoderFallbackException')
    expect(codec).toContain('!seen.Add(normalized)')
  })

  it('advertises exact versioned capabilities without changing the existing state/config protocol', () => {
    const literal = /if \(verb == "COPYCAPS"\) return ("(?:\\.|[^"\\])*");/.exec(plugin)![1]!
    expect(JSON.parse(JSON.parse(literal) as string)).toEqual({ protocol: 1, safeFields: true, groupIdentifiers: false, groupSize: false, sources: 'registered-bots' })
    expect(plugin).toContain('new(0, 3, 0)')
    expect(source('src/ASFStatusRelay.csproj')).toContain('<Version>0.3.0</Version>')
    expect(plugin).toContain('if (verb == "STATE")')
    expect(plugin).toContain('if (verb == "CONFIG")')
  })

  it('builds only its new offline fixtures and copies exactly DLL plus generic README', () => {
    const build = source('Build.ps1')
    expect(build).toContain('tests\\ASFStatusRelay.SelfTests.csproj')
    expect(build).toContain('--artifacts-path $taskArtifactsDirectory')
    expect(build).toContain("'out\\package'")
    expect([...build.matchAll(/^Copy-Item[^\r\n]+/gm)].map(match => match[0])).toHaveLength(2)
    expect(build).not.toMatch(/Copy-Item[^\r\n]+(?:\.json|VALIDATION|fixtures|observed)/i)
    expect(build).not.toMatch(/Start-Process|Invoke-RestMethod|Invoke-WebRequest|ssh |scp |Restart-Service|Stop-Service/)
    expect(source('tests/Program.cs')).toContain('upload policy round trip')
    expect(source('README.md')).toContain('No account, server address, password, user configuration or captured presence data is included.')
  })
})
