; Reeldeck uninstaller: leave nothing behind.
;
; The install folder is removed by electron-builder's own uninstaller. This removes what
; the app wrote OUTSIDE it, for the user who is uninstalling:
;   %APPDATA%\Reeldeck            settings, watch history, resume points, the signed-in
;                                 account, the ad-block filter cache, Chromium's storage
;   %LOCALAPPDATA%\Reeldeck       Chromium caches, if any landed there
;   %LOCALAPPDATA%\reeldeck-updater   downloaded but not yet installed updates
; Skipped during an UPDATE (the updater runs the old uninstaller before installing the new
; version), or every update would sign the user out and wipe their history.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    RMDir /r "$APPDATA\${PRODUCT_NAME}"
    RMDir /r "$LOCALAPPDATA\${PRODUCT_NAME}"
    RMDir /r "$LOCALAPPDATA\reeldeck-updater"
  ${endIf}
!macroend
