param(
    [Parameter(Mandatory = $true)]
    [string]$InstallDir
)

$ErrorActionPreference = 'Stop'
$taskName = 'Jieum-Engine'
$launcher = Join-Path $InstallDir 'engine\start-engine.cmd'
$pipe = '\\.\pipe\jieum-engine'
$userId = "$env:USERDOMAIN\$env:USERNAME"

if (-not (Test-Path $launcher)) {
    throw "지음 엔진 시작 파일을 찾지 못했습니다: $launcher"
}

Get-Process jieum-engine -ErrorAction SilentlyContinue |
    Stop-Process -Force -ErrorAction SilentlyContinue

$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/d /c `"$launcher`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
    -Principal $principal -Description '지음 한자 입력기 엔진' -Force | Out-Null
Start-ScheduledTask -TaskName $taskName

for ($i = 0; $i -lt 60; $i++) {
    if (Test-Path $pipe) {
        exit 0
    }
    Start-Sleep -Milliseconds 500
}

throw '지음 엔진이 30초 안에 시작되지 않았습니다.'
