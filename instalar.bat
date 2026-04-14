@echo off
title FIFA Liga - Instalador
color 0B
echo.
echo  =============================
echo    FIFA Liga - Instalador
echo  =============================
echo.

cd /d "%~dp0"

REM --- Verificar Node.js ---
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo  Node.js no encontrado. Descargando instalador...
    echo  Esto puede tardar unos minutos.
    echo.
    powershell -Command "Invoke-WebRequest -Uri 'https://nodejs.org/dist/v20.19.0/node-v20.19.0-x64.msi' -OutFile '%TEMP%\node_installer.msi' -UseBasicParsing"
    echo  Instalando Node.js...
    msiexec /i "%TEMP%\node_installer.msi" /quiet /norestart
    set "PATH=%PATH%;C:\Program Files\nodejs"
    echo  Node.js instalado!
    echo.
    REM Marcar que nosotros instalamos Node.js
    echo 1 > "%~dp0.nodejs_by_fifaLiga"
) else (
    echo  Node.js ya estaba instalado, no lo tocaremos al desinstalar.
)

REM --- Instalar dependencias ---
echo  Instalando dependencias...
call npm install
echo.

REM --- Crear acceso directo en el escritorio ---
echo  Creando acceso directo en el escritorio...
set "VBS_PATH=%~dp0FIFA Liga.vbs"
powershell -Command "$ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut([Environment]::GetFolderPath('Desktop') + '\FIFA Liga.lnk'); $s.TargetPath = 'wscript.exe'; $s.Arguments = '/b \"%VBS_PATH%\"'; $s.WorkingDirectory = '%~dp0'; $s.IconLocation = 'shell32.dll,13'; $s.Description = 'FIFA Liga'; $s.Save()"

echo.
echo  =============================
echo    Instalacion completada!
echo  =============================
echo.
echo  Busca el icono "FIFA Liga" en tu escritorio
echo  y dale doble click para abrir.
echo.
pause
