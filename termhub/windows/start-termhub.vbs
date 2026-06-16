' termhub startup launcher (no admin required).
' Runs the server hidden at logon. Place a copy/shortcut in the Startup folder.
Dim sh, fso, here
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
' Project dir = parent of this script's folder (..\ from windows\).
here = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
sh.CurrentDirectory = here
' 0 = hidden window, False = don't wait.
sh.Run "node.exe server.js", 0, False
