@echo off
rem Windows launcher for the Tokenmeter native-messaging host.
rem Firefox/Zen executes this; it must run node against tokenmeter-host.js.
rem Requires Node.js on PATH.
node "%~dp0tokenmeter-host.js" %*
