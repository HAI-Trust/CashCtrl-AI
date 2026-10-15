@echo off
cd /d "%~dp0"
"C:\Program Files\Git\bin\git.exe" add .
"C:\Program Files\Git\bin\git.exe" commit -m "Automatisches Backup"
"C:\Program Files\Git\bin\git.exe" push
pause