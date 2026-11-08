@echo off
rem Windows launcher for the bin\gh shim (picks the GitHub token by repo owner).
if defined FACTORY_PYTHON ("%FACTORY_PYTHON%" "%~dp0gh" %*) else (python "%~dp0gh" %*)
exit /b %ERRORLEVEL%
