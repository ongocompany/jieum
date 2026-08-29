@echo off
setlocal
set "JIEUM_ROOT=%~dp0.."
if not exist "%LOCALAPPDATA%\Jieum" mkdir "%LOCALAPPDATA%\Jieum"
"%~dp0jieum-engine.exe" --socket "\\.\pipe\jieum-engine" --dict "%JIEUM_ROOT%\dict" >> "%LOCALAPPDATA%\Jieum\engine.out" 2>&1
