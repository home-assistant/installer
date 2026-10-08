param(
    [Parameter(Mandatory)][ValidateSet('Prepare', 'Sign', 'Verify')][string]$Mode,
    [string]$File
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$signingDirectory = Join-Path $env:RUNNER_TEMP 'windows-signing'
$signTool = Join-Path $signingDirectory 'sdk/bin/10.0.26100.0/x64/signtool.exe'
$metadata = Join-Path $signingDirectory 'metadata.json'

if ($Mode -eq 'Prepare') {
    foreach ($name in @('AZURE_CLIENT_ID', 'AZURE_TENANT_ID', 'WINDOWS_SIGNING_ENDPOINT',
            'WINDOWS_SIGNING_ACCOUNT', 'WINDOWS_SIGNING_PROFILE', 'WINDOWS_SIGNING_SUBJECT')) {
        if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($name))) {
            throw "The release environment must configure $name"
        }
    }
    if ($env:WINDOWS_SIGNING_ENDPOINT -cnotmatch '^https://[a-z0-9]+\.codesigning\.azure\.net/?$') {
        throw 'WINDOWS_SIGNING_ENDPOINT must be an Azure Artifact Signing regional HTTPS endpoint'
    }
    # Fresh, hash-pinned tools, never an Actions cache shared with another build.
    New-Item -ItemType Directory -Path $signingDirectory | Out-Null
    $packages = @(
        @{
            Name = 'microsoft.windows.sdk.buildtools'; Version = '10.0.26100.4188'; Folder = 'sdk'
            Hash = '180deb372659029864c10a0c04787833234d64aacd1d2c0661d2c00295d8e022'
        },
        @{
            Name = 'microsoft.artifactsigning.client'; Version = '1.0.128'; Folder = 'client'
            Hash = '74bd7d27e6ce1051409c38d9b46bc8df0400ecd643d51ffbf2ac00869061e40b'
        }
    )
    foreach ($package in $packages) {
        $archive = Join-Path $signingDirectory "$($package.Folder).zip"
        $name = $package.Name
        $version = $package.Version
        Invoke-WebRequest "https://api.nuget.org/v3-flatcontainer/$name/$version/$name.$version.nupkg" -OutFile $archive
        if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $package.Hash) {
            throw "Hash mismatch for $name $version"
        }
        Expand-Archive -LiteralPath $archive -DestinationPath (Join-Path $signingDirectory $package.Folder)
    }
    @{
        Endpoint = $env:WINDOWS_SIGNING_ENDPOINT
        CodeSigningAccountName = $env:WINDOWS_SIGNING_ACCOUNT
        CertificateProfileName = $env:WINDOWS_SIGNING_PROFILE
        # Only the Azure CLI session created by the protected OIDC login may sign.
        ExcludeCredentials = @('EnvironmentCredential', 'WorkloadIdentityCredential',
            'ManagedIdentityCredential', 'SharedTokenCacheCredential', 'VisualStudioCredential',
            'VisualStudioCodeCredential', 'AzurePowerShellCredential',
            'AzureDeveloperCliCredential', 'InteractiveBrowserCredential')
    } | ConvertTo-Json | Set-Content -LiteralPath $metadata -Encoding utf8NoBOM
    @{
        bundle = @{
            windows = @{
                nsis = @{ installerHooks = (Join-Path $PSScriptRoot 'windows-signing.nsh') }
                signCommand = @{
                    cmd = 'pwsh'
                    args = @('-NoLogo', '-NoProfile', '-NonInteractive', '-File',
                        $PSCommandPath, '-Mode', 'Sign', '-File', '%1')
                }
            }
        }
    } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $signingDirectory 'tauri-signing.json') -Encoding utf8NoBOM
    return
}

if ([string]::IsNullOrWhiteSpace($File) -or -not (Test-Path -LiteralPath $File -PathType Leaf)) {
    throw 'Expected an existing file to sign or verify'
}
if ([string]::IsNullOrWhiteSpace($env:WINDOWS_SIGNING_SUBJECT)) {
    throw 'The release environment must configure WINDOWS_SIGNING_SUBJECT'
}
$File = (Resolve-Path -LiteralPath $File).Path
if ($Mode -eq 'Sign') {
    $dlib = Join-Path $signingDirectory 'client/bin/x64/Azure.CodeSigning.Dlib.dll'
    & $signTool sign /fd SHA256 /tr http://timestamp.acs.microsoft.com /td SHA256 `
        /dlib $dlib /dmdf $metadata /d 'Home Assistant Installer' $File
    if ($LASTEXITCODE -ne 0) { throw "SignTool signing failed: $LASTEXITCODE" }
}

# /tw makes missing timestamps a warning; any nonzero exit (including warnings)
# is a failure. Also check the publisher so a valid but wrong profile is rejected.
& $signTool verify /pa /all /tw $File
if ($LASTEXITCODE -ne 0) { throw "SignTool verification failed: $LASTEXITCODE" }
$signature = Get-AuthenticodeSignature -LiteralPath $File
if ($signature.Status -ne 'Valid' -or $null -eq $signature.TimeStamperCertificate -or
    $null -eq $signature.SignerCertificate -or
    $signature.SignerCertificate.Subject -cne $env:WINDOWS_SIGNING_SUBJECT) {
    throw "Expected a valid, timestamped signature from WINDOWS_SIGNING_SUBJECT: $File"
}
