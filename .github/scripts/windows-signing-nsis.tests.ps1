param([string]$MakeNsis = 'makensis')

# Compile harmless fixtures only. Never run the generated Windows installer.
$ErrorActionPreference = 'Stop'
$temporary = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString())
$null = New-Item -ItemType Directory -Path $temporary
$savedFailure = $env:SIGNING_TEST_FAILURE
try {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'windows-signing.nsh') -Destination $temporary
    @'
param([string]$Mode, [string]$File)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $File -PathType Leaf)) { throw 'Missing uninstaller' }
$marker = Join-Path $PSScriptRoot 'signed'
if ($Mode -eq 'Sign') {
    if ($env:SIGNING_TEST_FAILURE -eq 'sign') { exit 1 }
    Set-Content -LiteralPath $marker -Value 'signed'
} else {
    if (-not (Test-Path -LiteralPath $marker)) { throw 'Signing must succeed before verification' }
    if ($env:SIGNING_TEST_FAILURE -eq 'verify') { exit 2 }
    Set-Content -LiteralPath (Join-Path $PSScriptRoot 'verified') -Value 'verified'
}
'@ | Set-Content -LiteralPath (Join-Path $temporary 'windows-signing.ps1')
    @'
Unicode true
Name "Signing regression fixture"
OutFile "fixture.exe"
!include "windows-signing.nsh"
!if "$%SIGNING_TEST_FAILURE%" == "empty"
!define UNINSTALLERSIGNCOMMAND ""
!else
!define UNINSTALLERSIGNCOMMAND 'pwsh -NoLogo -NoProfile -NonInteractive -File "${WINDOWS_SIGNING_SCRIPT}" -Mode Sign -File "%1"'
; Match Tauri's unchecked finalizer and later PREINSTALL macro expansion.
!uninstfinalize '${UNINSTALLERSIGNCOMMAND}'
!endif
Section
  !insertmacro NSIS_HOOK_PREINSTALL
  WriteUninstaller "$TEMP\fixture-uninstall.exe"
SectionEnd
Section "Uninstall"
SectionEnd
'@ | Set-Content -LiteralPath (Join-Path $temporary 'fixture.nsi')
    foreach ($failure in @('none', 'sign', 'verify', 'empty')) {
        Remove-Item -LiteralPath (Join-Path $temporary 'signed'), (Join-Path $temporary 'verified') -ErrorAction SilentlyContinue
        $env:SIGNING_TEST_FAILURE = $failure
        $output = & $MakeNsis (Join-Path $temporary 'fixture.nsi') 2>&1
        $code = $LASTEXITCODE
        if ($failure -eq 'none') {
            if ($code -ne 0 -or -not (Test-Path -LiteralPath (Join-Path $temporary 'verified'))) {
                throw "Successful signing must compile and verify: $output"
            }
        } elseif ($code -eq 0) {
            throw "NSIS ignored the $failure failure: $output"
        } elseif ($failure -eq 'empty') {
            if (($output -join "`n") -notmatch 'Signed packaging requires an uninstaller signing command') {
                throw "NSIS failed for an unrelated reason: $output"
            }
        } elseif (($output -join "`n") -notmatch 'UninstFinalize command returned .*, aborting') {
            throw "NSIS failed for an unrelated reason: $output"
        }
    }
    Write-Output 'NSIS signing/verification failure regressions passed (compile-only mock signer).'
    # Expected compiler failures must not become the Actions shell's exit code.
    $global:LASTEXITCODE = 0
} finally {
    $env:SIGNING_TEST_FAILURE = $savedFailure
    Remove-Item -LiteralPath $temporary -Recurse -Force
}
