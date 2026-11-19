@echo off
title NodeStats
cd /d "%~dp0"
if not exist .env (
  copy .env.example .env >nul
  echo File .env dibuat dari .env.example. Isi ROS_HOST / ROS_USER / ROS_PASS lalu jalankan lagi.
  notepad .env
  exit /b
)
where node >nul 2>nul || (echo Node.js belum terinstall. Download di https://nodejs.org & pause & exit /b 1)
:loop
node server.js
echo.
echo Server berhenti, restart dalam 5 detik... (Ctrl+C untuk keluar)
timeout /t 5 >nul
goto loop
