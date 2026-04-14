@echo off
title FIFA Liga - Desinstalador
color 0C
echo.
echo  =============================
echo    FIFA Liga - Desinstalador
echo  =============================
echo.
echo  Esto va a eliminar FIFA Liga de tu PC.
echo.
set /p confirm=" Estas seguro? (S/N): "
if /i "%confirm%" neq "S" (
    echo.
    echo  Cancelado.
    pause
    exit
)

echo.

REM --- Cerrar servidor si esta corriendo ---
echo  Cerrando servidor...
taskkill /F /FI "WINDOWTITLE eq FIFA Liga*" >nul 2>&1
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3000"') do (
    taskkill /F /PID %%a >nul 2>&1
)

REM --- Eliminar acceso directo del escritorio ---
echo  Eliminando acceso directo del escritorio...
set "SHORTCUT=%USERPROFILE%\Desktop\FIFA Liga.lnk"
if exist "%SHORTCUT%" del "%SHORTCUT%"

REM --- Eliminar carpeta de la app ---
echo  Eliminando archivos...
cd /d "%TEMP%"
rmdir /s /q "%~dp0"

echo.
echo  =============================
echo    FIFA Liga desinstalado!
echo  =============================
echo.
echo  Node.js NO fue eliminado (puede usarse en otros programas).
echo.
pause
