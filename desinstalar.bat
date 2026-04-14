@echo off
title FIFA Liga - Desinstalador
color 0C
echo.
echo  =============================
echo    FIFA Liga - Desinstalador
echo  =============================
echo.
echo  Esto va a eliminar FIFA Liga y todo lo que instalo.
echo.
set /p confirm=" Estas seguro? (S/N): "
if /i "%confirm%" neq "S" (
    echo.
    echo  Cancelado.
    pause
    exit
)

echo.
cd /d "%~dp0"

REM --- Cerrar servidor si esta corriendo ---
echo  Cerrando servidor...
for /f "tokens=5" %%a in ('netstat -aon 2^>nul ^| findstr ":3000"') do (
    taskkill /F /PID %%a >nul 2>&1
)

REM --- Eliminar acceso directo del escritorio ---
echo  Eliminando acceso directo del escritorio...
if exist "%USERPROFILE%\Desktop\FIFA Liga.lnk" del "%USERPROFILE%\Desktop\FIFA Liga.lnk"
if exist "%PUBLIC%\Desktop\FIFA Liga.lnk"      del "%PUBLIC%\Desktop\FIFA Liga.lnk"

REM --- Desinstalar Node.js solo si lo instalamos nosotros ---
if exist "%~dp0.nodejs_by_fifaLiga" (
    echo  Desinstalando Node.js...
    powershell -Command "$node = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*' | Where-Object { $_.DisplayName -like '*Node.js*' }; if ($node) { $guid = $node.PSChildName; Start-Process msiexec -ArgumentList '/x',$guid,'/quiet','/norestart' -Wait }" >nul 2>&1
    REM Limpiar carpeta de Node.js si quedo
    if exist "C:\Program Files\nodejs" rmdir /s /q "C:\Program Files\nodejs" >nul 2>&1
    echo  Node.js eliminado.
) else (
    echo  Node.js no fue instalado por FIFA Liga, se deja intacto.
)

REM --- Eliminar carpeta completa de la app ---
echo  Eliminando archivos de FIFA Liga...
set "APP_DIR=%~dp0"
cd /d "%TEMP%"
rmdir /s /q "%APP_DIR%" >nul 2>&1

echo.
echo  =============================
echo    FIFA Liga desinstalado!
echo  El PC quedo como estaba antes.
echo  =============================
echo.
pause
