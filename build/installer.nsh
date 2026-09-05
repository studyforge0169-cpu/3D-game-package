; Universal Game Asset Hub — NSIS custom installer hooks (spec §19)
; Executed inside electron-builder's NSIS script.

!macro customInstall
  ; Register the "Open with UGAH" capability for supported 3D formats
  ; (view/import into library). File associations for our own formats are
  ; handled by electron-builder's fileAssociations config.
  WriteRegStr HKCU "Software\Classes\UniversalGameAssetHub.glb\shell\open\command" "" '"$INSTDIR\UniversalGameAssetHub.exe" "--import-file" "%1"'
  WriteRegStr HKCU "Software\Classes\UniversalGameAssetHub.glb" "" "GLB model (import to UGAH)"
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\UniversalGameAssetHub.glb"
!macroend
