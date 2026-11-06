; Extra steps for the Wavelog installer. Tauri's NSIS template runs these macros at the matching points.

!define RUN_KEY "Software\Microsoft\Windows\CurrentVersion\Run"
!define STARTUP_APPROVED "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run"
Var WavelogFirst

; The logger is a separate process, Tauri's "app is running" check only covers the main exe.
; Without this an update can't replace the logger exe.
!macro WAVELOG_STOP_LOGGER
  nsExec::Exec 'taskkill /F /T /IM wavelog-logger.exe'
  nsExec::Exec 'taskkill /F /T /IM sp-backend.exe'
  Sleep 400
!macroend

!macro NSIS_HOOK_PREINSTALL
  ; Is this the first install on this PC? (Read before anything creates the data folder.)
  StrCpy $WavelogFirst "1"
  ${If} ${FileExists} "$APPDATA\Wavelog\*.*"
  ${OrIf} ${FileExists} "$APPDATA\Spotify Stats\*.*"
    StrCpy $WavelogFirst "0"
  ${EndIf}

  !insertmacro WAVELOG_STOP_LOGGER

  ; Carry "Start with Windows" over from the old name. Read it first: the old uninstaller below deletes it.
  ReadRegStr $R8 HKCU "${RUN_KEY}" "Spotify Stats"
  ${If} $R8 != ""
    DeleteRegValue HKCU "${RUN_KEY}" "Spotify Stats"
    DeleteRegValue HKCU "${STARTUP_APPROVED}" "Spotify Stats"
    WriteRegStr HKCU "${RUN_KEY}" "Wavelog" '"$INSTDIR\wavelog.exe" --autostart'
  ${EndIf}

  ; Replace the install from before the rename ("Spotify Stats"). Its data folder stays and Wavelog keeps using it.
  ${If} ${FileExists} "$LOCALAPPDATA\Programs\Spotify Stats\uninstall.exe"
    nsExec::Exec 'taskkill /F /T /IM spotify-stats.exe'
    Sleep 400
    ExecWait '"$LOCALAPPDATA\Programs\Spotify Stats\uninstall.exe" /S _?=$LOCALAPPDATA\Programs\Spotify Stats'
    Delete "$LOCALAPPDATA\Programs\Spotify Stats\uninstall.exe"
    RMDir /r "$LOCALAPPDATA\Programs\Spotify Stats"
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; A logger only works while it runs, so new installs start with Windows. Turn it off in Settings > General.
  ${If} $WavelogFirst == "1"
    WriteRegStr HKCU "${RUN_KEY}" "Wavelog" '"$INSTDIR\wavelog.exe" --autostart'
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro WAVELOG_STOP_LOGGER
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Tauri already removes the Run value (not during updates); this clears Windows' on/off flag for it too.
  ${If} $UpdateMode <> 1
    DeleteRegValue HKCU "${STARTUP_APPROVED}" "Wavelog"
  ${EndIf}
  ; "Delete the application data" ticked: also remove the listening database and settings.
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    RMDir /r "$APPDATA\Wavelog"
    RMDir /r "$APPDATA\Spotify Stats"
  ${EndIf}
!macroend
