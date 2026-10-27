<#
ASFStatusRelay 0.3.0: build the safe-field companion and run offline self-tests.
Use an extracted ASF-generic directory matching the target ASF version.
This script does not connect to Steam, install the plugin, restart ASF, or create an archive.
It copies only the built DLL and generic README into out/package/. No user configuration is included.
#>
param(
    [Parameter(Mandatory = $true)][string]$ASFDirectory,
    [string]$Dotnet = 'dotnet'
)
$ErrorActionPreference = 'Stop'
$taskAsfReferenceDirectory = (Resolve-Path -LiteralPath $ASFDirectory).Path
if (-not (Test-Path -LiteralPath (Join-Path $taskAsfReferenceDirectory 'ArchiSteamFarm.dll'))) {
    throw 'ASFDirectory must contain the extracted ASF-generic package matching your server version.'
}
if (-not (Test-Path -LiteralPath (Join-Path $taskAsfReferenceDirectory 'SteamKit2.dll'))) {
    throw 'ASFDirectory must also contain the matching SteamKit2.dll from the same ASF-generic release.'
}
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
$env:DOTNET_NOLOGO = '1'
$taskPluginProject = Join-Path $PSScriptRoot 'src\ASFStatusRelay.csproj'
$taskTestsProject = Join-Path $PSScriptRoot 'tests\ASFStatusRelay.SelfTests.csproj'
$taskArtifactsDirectory = Join-Path $PSScriptRoot 'out\build'
& $Dotnet build $taskPluginProject --configuration Release --nologo --artifacts-path $taskArtifactsDirectory "-p:ASFDirectory=$taskAsfReferenceDirectory"
if ($LASTEXITCODE -ne 0) { throw 'Plugin build failed.' }
& $Dotnet build $taskTestsProject --configuration Release --nologo --artifacts-path $taskArtifactsDirectory "-p:ASFDirectory=$taskAsfReferenceDirectory"
if ($LASTEXITCODE -ne 0) { throw 'Self-test build failed.' }
& $Dotnet (Join-Path $taskArtifactsDirectory 'bin\ASFStatusRelay.SelfTests\release\ASFStatusRelay.SelfTests.dll')
if ($LASTEXITCODE -ne 0) { throw 'Self-tests failed.' }
$taskPluginPackageDirectory = Join-Path $PSScriptRoot 'out\package'
New-Item -ItemType Directory -Path $taskPluginPackageDirectory -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $taskArtifactsDirectory 'bin\ASFStatusRelay\release\ASFStatusRelay.dll') -Destination $taskPluginPackageDirectory -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'README.md') -Destination $taskPluginPackageDirectory -Force
Write-Output 'Build and offline self-tests passed. out/package contains only the safe-field DLL and generic README. Preserve existing server-side configuration when updating; installation and bot operations are manual.'
