' Launches Jarvis's autostart script with NO visible window.
Set sh = CreateObject("WScript.Shell")
root = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
sh.CurrentDirectory = root
sh.Run """" & root & "jarvis-autostart.bat""", 0, False
