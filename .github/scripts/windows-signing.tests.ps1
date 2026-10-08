# No signing service, credentials, native binaries, or extra test modules needed.
$ErrorActionPreference = 'Stop'
$script = Join-Path $PSScriptRoot 'windows-signing.ps1'
$names = @('RUNNER_TEMP', 'AZURE_CLIENT_ID', 'AZURE_TENANT_ID', 'WINDOWS_SIGNING_ENDPOINT',
    'WINDOWS_SIGNING_ACCOUNT', 'WINDOWS_SIGNING_PROFILE', 'WINDOWS_SIGNING_SUBJECT')
$saved = @{}
foreach ($name in $names) { $saved[$name] = [Environment]::GetEnvironmentVariable($name) }
$temporary = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString())
$null = New-Item -ItemType Directory -Path $temporary
$env:RUNNER_TEMP = $temporary
$env:AZURE_CLIENT_ID = 'test-client'
$env:AZURE_TENANT_ID = 'test-tenant'
$env:WINDOWS_SIGNING_ENDPOINT = 'https://swn.codesigning.azure.net'
$env:WINDOWS_SIGNING_ACCOUNT = 'test-account'
$env:WINDOWS_SIGNING_PROFILE = 'test-profile'
$env:WINDOWS_SIGNING_SUBJECT = 'CN=Test Publisher, O=Test Publisher, C=CH'
$directory = Join-Path $temporary 'windows-signing'
$signTool = Join-Path $directory 'sdk/bin/10.0.26100.0/x64/signtool.exe'
$file = Join-Path $temporary 'Home Assistant [beta] & check.exe'
Set-Content -LiteralPath $file -Value 'Not a real executable'

function Assert($condition, $message) {
    if (-not $condition) { throw $message }
}
function Expect-Failure([scriptblock]$action, [string]$message) {
    try { & $action } catch {
        Assert ($_.Exception.Message.Contains($message)) "Wrong failure: $_"
        return
    }
    throw "Expected failure: $message"
}
function Invoke-WebRequest { param($Uri, $OutFile) }
function Expand-Archive { param($LiteralPath, $DestinationPath) $global:expansions++ }
function Get-FileHash {
    param($LiteralPath, $Algorithm)
    if ($global:badHash) { return @{ Hash = 'wrong' } }
    if ($LiteralPath.EndsWith('sdk.zip')) {
        return @{ Hash = '180deb372659029864c10a0c04787833234d64aacd1d2c0661d2c00295d8e022' }
    }
    return @{ Hash = '74bd7d27e6ce1051409c38d9b46bc8df0400ecd643d51ffbf2ac00869061e40b' }
}
function Get-AuthenticodeSignature { param($LiteralPath) return $global:signature }

$global:badHash = $false
$global:expansions = 0
$global:calls = [Collections.Generic.List[object]]::new()
$global:signExit = 0
$global:verifyExit = 0
Set-Item -Path "Function:global:$signTool" -Value {
    $global:calls.Add(@($args))
    $global:LASTEXITCODE = if ($args[0] -eq 'sign') { $global:signExit } else { $global:verifyExit }
}
try {
    foreach ($name in $names | Where-Object { $_ -ne 'RUNNER_TEMP' }) {
        $value = [Environment]::GetEnvironmentVariable($name)
        [Environment]::SetEnvironmentVariable($name, ' ')
        Expect-Failure { & $script -Mode Prepare } $name
        [Environment]::SetEnvironmentVariable($name, $value)
    }
    $env:WINDOWS_SIGNING_ENDPOINT = 'https://swn.codesigning.azure.net.attacker.example'
    Expect-Failure { & $script -Mode Prepare } 'regional HTTPS endpoint'
    $env:WINDOWS_SIGNING_ENDPOINT = 'https://swn.codesigning.azure.net'
    $global:badHash = $true
    Expect-Failure { & $script -Mode Prepare } 'Hash mismatch'
    Assert ($global:expansions -eq 0) 'Downloaded code was unpacked before its hash was checked'
    Remove-Item -LiteralPath $directory -Recurse -Force
    $global:badHash = $false
    & $script -Mode Prepare
    Assert ($global:expansions -eq 2) 'Both pinned signing tools must be prepared'
    $config = Get-Content -LiteralPath (Join-Path $directory 'tauri-signing.json') -Raw | ConvertFrom-Json
    $command = $config.bundle.windows.signCommand
    Assert ($config.bundle.windows.nsis.installerHooks -eq (Join-Path $PSScriptRoot 'windows-signing.nsh')) 'NSIS must enforce uninstaller verification'
    Assert ($command.cmd -eq 'pwsh') 'Expected structured PowerShell command'
    Assert ($command.args[-1] -eq '%1') 'Tauri file placeholder must be a separate argument'
    Assert ($command.args[4] -eq $script) 'Signing script must have an absolute path for NSIS'
    $metadata = Get-Content -LiteralPath (Join-Path $directory 'metadata.json') -Raw | ConvertFrom-Json
    Assert ($metadata.ExcludeCredentials.Count -eq 9) 'Unexpected credential fallback'
    Assert ($metadata.ExcludeCredentials -contains 'EnvironmentCredential') 'Environment credentials must be excluded'
    Assert ($metadata.ExcludeCredentials -notcontains 'AzureCliCredential') 'OIDC CLI credentials must remain enabled'

    $global:signature = @{ Status = 'Valid'; TimeStamperCertificate = @{};
        SignerCertificate = @{ Subject = $env:WINDOWS_SIGNING_SUBJECT } }
    & $script -Mode Sign -File $file
    Assert ($global:calls.Count -eq 2) 'Signing must be followed by verification'
    Assert ($global:calls[0][-1] -eq $file) 'Spaces, brackets, and shell metacharacters must remain one literal argument'
    Assert (($global:calls[0][0..6] -join ',') -eq 'sign,/fd,SHA256,/tr,http://timestamp.acs.microsoft.com,/td,SHA256') 'SHA256 timestamp parameters changed'
    Assert (($global:calls[1][0..3] -join ',') -eq 'verify,/pa,/all,/tw') 'Signature policy and timestamp verification required'
    $global:calls.Clear()
    & $script -Mode Verify -File $file
    Assert ($global:calls.Count -eq 1 -and $global:calls[0][0] -eq 'verify') 'Final verification must not re-sign'
    $global:signExit = 1
    $global:calls.Clear()
    Expect-Failure { & $script -Mode Sign -File $file } 'signing failed'
    Assert ($global:calls.Count -eq 1) 'Failed signing must stop immediately'
    $global:signExit = 0
    foreach ($code in @(1, 2)) {
        $global:verifyExit = $code
        Expect-Failure { & $script -Mode Verify -File $file } 'verification failed'
    }
    $global:verifyExit = 0
    $global:signature.Status = 'NotSigned'
    Expect-Failure { & $script -Mode Verify -File $file } 'valid, timestamped signature'
    $global:signature.Status = 'Valid'
    $global:signature.TimeStamperCertificate = $null
    Expect-Failure { & $script -Mode Verify -File $file } 'valid, timestamped signature'
    $global:signature.TimeStamperCertificate = @{}
    $global:signature.SignerCertificate.Subject = 'CN=Wrong Publisher'
    Expect-Failure { & $script -Mode Verify -File $file } 'valid, timestamped signature'
    Expect-Failure { & $script -Mode Sign -File (Join-Path $temporary 'missing.exe') } 'existing file'
    Write-Output 'Windows signing guard and argument tests passed (mock signer).'
} finally {
    Remove-Item -LiteralPath $temporary -Recurse -Force
    Remove-Item -LiteralPath "Function:global:$signTool"
    foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name, $saved[$name]) }
}
