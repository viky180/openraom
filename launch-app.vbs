Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
projectPath = fso.GetParentFolderName(WScript.ScriptFullName)
WshShell.CurrentDirectory = projectPath
WshShell.Run "cmd /c launch-app.cmd", 0, False
