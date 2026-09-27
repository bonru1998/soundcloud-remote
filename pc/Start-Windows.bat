@echo off
cd /d "%~dp0"
if exist "python\python.exe" (
  "python\python.exe" server.py
  pause
  exit /b
)
py -3 -c "import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)" >nul 2>nul
if %errorlevel% equ 0 (
  py -3 server.py
  pause
  exit /b
)
python -c "import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)" >nul 2>nul
if %errorlevel% equ 0 (
  python server.py
  pause
  exit /b
)
echo Downloading official portable Python. This is needed only once.
powershell.exe -NoProfile -Command "& { $ErrorActionPreference = 'Stop'; [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; $zip = Join-Path (Get-Location) 'python-download.zip'; try { Invoke-WebRequest -UseBasicParsing -Uri 'https://www.python.org/ftp/python/3.13.15/python-3.13.15-embed-amd64.zip' -OutFile $zip; if ((Get-FileHash -Algorithm SHA256 $zip).Hash.ToLower() -ne 'd1f04d990aee1253d8569e8e5104e30fa9f5fa830899f14843448872d936a2cf') { throw 'Downloaded Python failed its integrity check. Please retry.' }; Expand-Archive -LiteralPath $zip -DestinationPath 'python' -Force; Remove-Item -LiteralPath $zip } catch { Write-Host $_; exit 1 } }"
if errorlevel 1 (
  echo Could not prepare Python. Check your internet connection and run this again.
  pause
  exit /b 1
)
"python\python.exe" server.py
pause
