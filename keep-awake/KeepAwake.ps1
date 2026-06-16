#Requires -Version 5.1
<#
.SYNOPSIS
    Keep a Windows session awake so it never registers as idle / logs out.
.DESCRIPTION
    Taps a harmless key (F15) on a timer and tells Windows the system is in
    use via SetThreadExecutionState. Nothing visible is typed, nothing is
    clicked. Stop it by closing the window or ending the powershell process.

    Single-instance guarded: a second launch exits quietly.
#>

# --- Single-instance guard: if one copy is already running, exit quietly. ---
$mutex = New-Object System.Threading.Mutex($false, "Global\KeepAwake_$env:USERNAME")
if (-not $mutex.WaitOne(0)) {
    # Another instance already holds the mutex; this launch is redundant.
    return
}

Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class KA {
    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT { public uint type; public InputUnion u; }
    [StructLayout(LayoutKind.Explicit)]
    public struct InputUnion { [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT {
        public ushort wVk; public ushort wScan; public uint dwFlags;
        public uint time; public IntPtr dwExtraInfo;
    }
    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint SendInput(uint n, INPUT[] pInputs, int cbSize);

    public static void TapF15() {
        INPUT[] inp = new INPUT[2];
        inp[0].type = 1; inp[0].u.ki.wVk = 0x7E;                 // F15 down
        inp[1].type = 1; inp[1].u.ki.wVk = 0x7E; inp[1].u.ki.dwFlags = 2; // F15 up
        SendInput(2, inp, Marshal.SizeOf(typeof(INPUT)));
    }
}
'@

# Also tell Windows the system is in use (prevents sleep/display-off as backup).
$ES_CONTINUOUS      = [uint32]"0x80000000"
$ES_SYSTEM_REQUIRED = [uint32]"0x00000001"
$ES_DISPLAY_REQUIRED= [uint32]"0x00000002"
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class PW {
    [DllImport("kernel32.dll")]
    public static extern uint SetThreadExecutionState(uint esFlags);
}
'@

Write-Host "KeepAwake running. F15 tapped every 59s. Leave this window open (or minimize it)."
Write-Host "Press Ctrl+C or close this window to stop."

while ($true) {
    [PW]::SetThreadExecutionState($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED -bor $ES_DISPLAY_REQUIRED) | Out-Null
    [KA]::TapF15()
    Start-Sleep -Seconds 59
}
