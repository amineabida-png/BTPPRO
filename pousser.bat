@echo off
setlocal
cd /d "%~dp0"

echo ================================================
echo    BTPPro - Envoi vers GitHub / Railway
echo ================================================
echo.

where git >nul 2>nul
if errorlevel 1 (
  echo [ERREUR] Git n'est pas installe ou introuvable.
  echo Telecharge-le ici : https://git-scm.com/download/win
  echo.
  pause
  exit /b
)

if not exist ".git" (
  echo [ERREUR] Ce fichier doit etre DANS le dossier btppro
  echo (le dossier qui contient server.js et le dossier cache .git).
  echo.
  pause
  exit /b
)

echo Fichiers modifies :
git status --short
echo.

set "msg=Mise a jour BTPPro"
set /p "msg=Message (ou appuie sur Entree) : "

echo.
echo --- Envoi en cours ---
git add -A
git commit -m "%msg%"
git push

echo.
echo ================================================
echo  Termine.
echo  Attends 1-2 min puis fais Ctrl + F5 sur le site.
echo  (Si une erreur s'affiche ci-dessus, copie-la moi)
echo ================================================
echo.
pause
endlocal
