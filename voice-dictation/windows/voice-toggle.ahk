; voice-toggle.ahk -- AutoHotkey v2
;
; Ctrl+Alt+V : first press starts recording, second press stops and transcribes.
; Esc        : cancel active recording (only fires while recording is in progress).
; Tray icon  : right-click → Cleanup backend to switch between Claude/Ollama/Python.

#Requires AutoHotkey v2.0
#SingleInstance Force

InstallDir  := EnvGet("LOCALAPPDATA") "\voice-dictation"
PythonwExe  := InstallDir "\venv\Scripts\pythonw.exe"
RecorderPy  := InstallDir "\recorder.py"
OverlayPy   := InstallDir "\overlay.py"

TmpDir      := EnvGet("TEMP")
CancelFlag  := TmpDir "\vd-cancel.flag"
StopFlag    := TmpDir "\vd-stop.flag"
RunningFlag := TmpDir "\vd-running.flag"
BackendFile := TmpDir "\vd-cleanup-backend.txt"

; The running flag holds the recorder's PID. A flag whose process is gone was
; left by a recorder that died (killed, crashed) — without this check it would
; wedge the hotkey: every press would only write a stop flag nobody reads.
IsRecording() {
    global RunningFlag
    if !FileExist(RunningFlag)
        return false
    try
        pid := Integer(Trim(FileRead(RunningFlag)))
    catch
        pid := 0
    if (pid && ProcessExist(pid))
        return true
    try FileDelete(RunningFlag)
    return false
}

; ---------------------------------------------------------------------------
; Tray icon + cleanup backend submenu
; ---------------------------------------------------------------------------

A_TrayMenu.Add()  ; separator

CleanupMenu := Menu()
CleanupMenu.Add("Claude API",        BackendHandler.Bind("claude"))
CleanupMenu.Add("Ollama (local)",    BackendHandler.Bind("ollama"))
CleanupMenu.Add("Python (instant)",  BackendHandler.Bind("python"))

A_TrayMenu.Add("Cleanup backend", CleanupMenu)
A_TrayMenu.Add("Transcription history...", HistoryHandler)

; Checkmark the current selection on startup
_InitBackendMenu()

_InitBackendMenu() {
    global BackendFile, CleanupMenu
    try
        current := FileRead(BackendFile).Trim()
    catch
        current := "claude"
    _UpdateBackendCheckmarks(current)
}

_UpdateBackendCheckmarks(current) {
    global CleanupMenu
    for label in ["Claude API", "Ollama (local)", "Python (instant)"] {
        CleanupMenu.UnCheck(label)
    }
    if (current = "claude")
        CleanupMenu.Check("Claude API")
    else if (current = "ollama")
        CleanupMenu.Check("Ollama (local)")
    else if (current = "python")
        CleanupMenu.Check("Python (instant)")
}

BackendHandler(backend, *) {
    global BackendFile
    try FileOpen(BackendFile, "w").Write(backend)
    _UpdateBackendCheckmarks(backend)
    labels := Map("claude", "Claude API", "ollama", "Ollama (local)", "python", "Python (instant)")
    TrayTip("Voice Dictation", "Cleanup: " labels[backend], 0x10)
    SetTimer(() => TrayTip(), -2000)
}

HistoryHandler(*) {
    global PythonwExe, OverlayPy, InstallDir
    if (!FileExist(PythonwExe)) {
        ShowToast("recorder not installed -- re-run install.ps1")
        return
    }
    Run('"' PythonwExe '" "' OverlayPy '" --history', InstallDir, "Hide")
}

; ---------------------------------------------------------------------------
; Hotkeys
; ---------------------------------------------------------------------------

ShowToast(msg) {
    TrayTip("Voice", msg, 0x10)
    SetTimer(() => TrayTip(), -1500)
}

^!v:: {
    if IsRecording() {
        ; 2nd press: request graceful stop -> proceed to transcription
        try FileAppend("", StopFlag)
    } else {
        ; 1st press: launch recorder
        try FileDelete(CancelFlag)
        try FileDelete(StopFlag)
        if (!FileExist(PythonwExe)) {
            ShowToast("recorder not installed -- re-run install.ps1")
            return
        }
        Run('"' PythonwExe '" "' RecorderPy '"', InstallDir, "Hide")
    }
}

; Esc cancels only while recording is active
#HotIf IsRecording()
Esc:: {
    try FileAppend("", CancelFlag)
}
#HotIf
