@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ============================================================
echo   GIS Tools 一键部署包生成
echo ============================================================
echo.

REM ---------------- 环境检查 ----------------
where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] 未检测到 node，请先安装 Node.js 22+
    goto :fail
)
where pnpm >nul 2>nul
if errorlevel 1 (
    echo [ERROR] 未检测到 pnpm，请先执行: volta install pnpm@9
    goto :fail
)

for /f "delims=" %%v in ('node -v') do set NODE_VER=%%v
for /f "delims=" %%v in ('pnpm -v') do set PNPM_VER=%%v
echo [INFO] node !NODE_VER!   pnpm !PNPM_VER!
echo.

REM -------- 依赖安装（node_modules 缺失时自动安装）--------
if not exist "node_modules" (
    echo [INFO] 首次运行，安装依赖中（约 1-3 分钟）...
    call pnpm install
    if errorlevel 1 goto :fail
) else (
    echo [INFO] 依赖已就绪，跳过安装
)
echo.

REM ---- 生成部署包（支持透传参数，如: deploy.bat --base=/）----
echo [INFO] 开始构建并打包...
node scripts\build-deploy.mjs %*
if errorlevel 1 goto :fail

echo.
echo [OK] 部署包已生成: %~dp0release
start "" "%~dp0release"
echo 按任意键关闭...
pause >nul
exit /b 0

:fail
echo.
echo [ERROR] 部署包生成失败，请检查上方日志
echo 按任意键关闭...
pause >nul
exit /b 1
