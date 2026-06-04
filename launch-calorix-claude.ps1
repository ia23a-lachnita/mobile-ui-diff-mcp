$ProjectDir = "C:\Users\xursc\projects\calorix"
$SessionName = "Calorix"

Start-Process powershell.exe `
  -WorkingDirectory $ProjectDir `
  -ArgumentList @(
    "-NoExit",
    "-Command",
    "claude --dangerously-skip-permissions --model claude-sonnet-4-6 --remote-control `"$SessionName`""
  )