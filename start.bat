@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Skialp CZ/SK
echo Skialp CZ/SK - spoustim server...
echo (Toto okno nech otevrene, dokud aplikaci pouzivas. Zavrenim se aplikace vypne.)
echo.

set "PY="
where py >nul 2>nul && set "PY=py -3"
if not defined PY where python >nul 2>nul && set "PY=python"
if not defined PY (
  echo CHYBA: Nenasel jsem Python. Nainstaluj ho z https://www.python.org/downloads/
  echo        a pri instalaci zaskrtni "Add python.exe to PATH".
  pause
  exit /b 1
)

%PY% server.py %*
echo.
echo Server skoncil (kod %errorlevel%). Pokud se objevila chyba, posli mi text vyse.
pause
