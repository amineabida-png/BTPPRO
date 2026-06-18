@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ================================================
echo    BTPPro  -  Mise a jour vers GitHub / Railway
echo ================================================
echo.

if not exist ".git" (
  echo [ERREUR] Place ce fichier DANS ton dossier btppro
  echo (celui qui contient server.js et le dossier cache .git).
  echo.
  pause
  exit /b
)

echo Fichiers modifies :
git status --short
echo.

set /p msg="Message (ou appuie sur Entree pour un message par defaut) : "
if "%msg%"=="" set msg=Mise a jour BTPPro

echo.
echo --- Envoi en cours... ---
git add .
git commit -m "%msg%"
git push

echo.
echo ================================================
echo  Termine. Railway va redeployer automatiquement.
echo  Recharge ton site avec Ctrl + F5 dans 1-2 min.
echo ================================================
echo.
pause
