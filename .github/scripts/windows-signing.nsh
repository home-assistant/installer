!define WINDOWS_SIGNING_SCRIPT "${__FILEDIR__}/windows-signing.ps1"

!macro NSIS_HOOK_PREINSTALL
  ; Tauri registers signing without checking its exit status. Append a fatal
  ; verification after that finalizer, before the uninstaller is embedded.
  !if '${UNINSTALLERSIGNCOMMAND}' == ''
    !error "Signed packaging requires an uninstaller signing command"
  !endif
  !uninstfinalize 'pwsh -NoLogo -NoProfile -NonInteractive -File "${WINDOWS_SIGNING_SCRIPT}" -Mode Verify -File "%1"' = 0
!macroend
