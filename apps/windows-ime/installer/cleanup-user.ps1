$ErrorActionPreference = 'SilentlyContinue'

Get-Process jieum-engine,jieum-tip-host -ErrorAction SilentlyContinue |
    Stop-Process -Force -ErrorAction SilentlyContinue

Unregister-ScheduledTask -TaskName 'Jieum-Engine' -Confirm:$false -ErrorAction SilentlyContinue

# 사용자 조합·설정·진단 로그는 업데이트와 재설치를 위해 남긴다.
exit 0
