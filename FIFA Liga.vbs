Dim dir
dir = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\") - 1)

Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "cmd /c cd /d """ & dir & """ && node server.js", 0, False
WScript.Sleep 1500
WshShell.Run "http://localhost:3000"
