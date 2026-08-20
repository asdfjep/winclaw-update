@echo off
REM ============================================================
REM  Hs-WinClaw Build + Installer Script
REM ============================================================
REM  Prerequisites:
REM    - .NET 10 SDK
REM    - Inno Setup 6 (ISCC.exe in PATH)
REM  Note: Embedded local hs-rag / wwwroot-rag build removed (cloud KB only).
REM ============================================================

setlocal enabledelayedexpansion

set ROOT=%~dp0
set PUBLISH_DIR=%ROOT%publish\win-x64
set INSTALLER_DIR=%ROOT%installer
set VERSION_FILE=%ROOT%VERSION

echo.
echo ============================================================
echo   Step 0: Read and validate version
echo ============================================================
if not exist "%VERSION_FILE%" (
    echo ERROR: VERSION file not found at %VERSION_FILE%
    echo Please create a VERSION file with the version number (e.g., 1.0.0^)
    exit /b 1
)
set /p APP_VERSION=<"%VERSION_FILE%"
echo Version: %APP_VERSION%

REM Validate version format (basic check: X.Y.Z)
echo %APP_VERSION% | findstr /r "^[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*" >nul
if errorlevel 1 (
    echo WARNING: Version '%APP_VERSION%' does not match expected format X.Y.Z
    echo Continuing anyway...
)

echo.
echo ============================================================
echo   Step 0.5: Generate CHANGELOG from git log
echo ============================================================
if exist "%ROOT%.git" (
    echo Generating CHANGELOG.md from git log...
    cd /d "%ROOT%"
    
    REM Get the last tag or commit hash
    for /f "delims=" %%i in ('git describe --tags --abbrev=0 2^>nul') do set LAST_TAG=%%i
    
    if defined LAST_TAG (
        echo Last tag: !LAST_TAG!
        echo # Changelog> "%ROOT%CHANGELOG.md"
        echo.>> "%ROOT%CHANGELOG.md"
        echo ## [%APP_VERSION%] - %DATE%>> "%ROOT%CHANGELOG.md"
        echo.>> "%ROOT%CHANGELOG.md"
        
        REM Get commits since last tag
        git log !LAST_TAG!..HEAD --pretty=format:"- %%s" --no-merges>> "%ROOT%CHANGELOG.md" 2>nul
        
        if errorlevel 1 (
            echo No new commits since !LAST_TAG!
            echo - No changes>> "%ROOT%CHANGELOG.md"
        )
    ) else (
        echo No previous tags found, using recent commits...
        echo # Changelog> "%ROOT%CHANGELOG.md"
        echo.>> "%ROOT%CHANGELOG.md"
        echo ## [%APP_VERSION%] - %DATE%>> "%ROOT%CHANGELOG.md"
        echo.>> "%ROOT%CHANGELOG.md"
        git log -20 --pretty=format:"- %%s" --no-merges>> "%ROOT%CHANGELOG.md" 2>nul
    )
    
    echo CHANGELOG.md generated
) else (
    echo WARNING: Not a git repository, skipping CHANGELOG generation
)

echo.
echo ============================================================
echo   Step 1: dotnet publish (self-contained win-x64)
echo ============================================================
cd /d "%ROOT%"
if exist "%PUBLISH_DIR%" rmdir /s /q "%PUBLISH_DIR%"
dotnet publish src\HsWinClaw.Desktop\HsWinClaw.Desktop.csproj ^
    -c Release ^
    -r win-x64 ^
    --self-contained true ^
    -p:PublishSingleFile=false ^
    -p:Version=%APP_VERSION% ^
    -o "%PUBLISH_DIR%"
if errorlevel 1 (
    echo ERROR: dotnet publish failed
    exit /b 1
)
echo Publish complete (version: %APP_VERSION%^)

echo.
echo ============================================================
echo   Step 2: Build Inno Setup installer
echo ============================================================
if exist "%INSTALLER_DIR%" rmdir /s /q "%INSTALLER_DIR%"
mkdir "%INSTALLER_DIR%"

set ISCC=
where ISCC.exe >nul 2>&1
if not errorlevel 1 (
    for /f "delims=" %%i in ('where ISCC.exe') do (
        set ISCC=%%i
        goto :iscc_found
    )
)
:iscc_found
if not defined ISCC if exist "%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe" set ISCC=%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe
if not defined ISCC if exist "%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe" set ISCC=%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe
if not defined ISCC if exist "%ProgramFiles%\Inno Setup 6\ISCC.exe" set ISCC=%ProgramFiles%\Inno Setup 6\ISCC.exe

if defined ISCC (
    echo Using ISCC: !ISCC!
    "!ISCC!" "%ROOT%installer.iss"
    if errorlevel 1 (
        echo ERROR: Inno Setup compile failed
        exit /b 1
    )
    echo Installer built successfully: %INSTALLER_DIR%\Hs-WinClaw-Setup-%APP_VERSION%.exe
) else (
    echo ERROR: Inno Setup 6 not found. Install from https://jrsoftware.org/isinfo.php
    echo You can still find the published files in: %PUBLISH_DIR%
    exit /b 1
)

echo.
echo ============================================================
echo   Step 3: Generate update manifest (winclaw-update.json)
echo ============================================================
REM Upload installer\Hs-WinClaw-Setup-%APP_VERSION%.exe and
REM installer\winclaw-update.json together to the update server path.
REM ROOT ends with a backslash; strip it so the quoted path does not
REM escape the closing quote when PowerShell parses the argument list.
set ROOT_NOSLASH=%ROOT:~0,-1%
powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%tools\gen_update_manifest.ps1" -RepoRoot "%ROOT_NOSLASH%" -Version "%APP_VERSION%"
if errorlevel 1 (
    echo ERROR: update manifest generation failed
    exit /b 1
)

echo.
echo ============================================================
echo   BUILD COMPLETE
echo   Version:   %APP_VERSION%
echo   Installer: %INSTALLER_DIR%\Hs-WinClaw-Setup-%APP_VERSION%.exe
echo   Manifest:  %INSTALLER_DIR%\winclaw-update.json
echo   Publish:   %PUBLISH_DIR%
echo ============================================================
endlocal
