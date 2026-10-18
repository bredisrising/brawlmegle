#!/bin/bash
# Stop any Edge left from a perf run: only processes started with the brawlperf profile, never your own Edge.
powershell.exe -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Where-Object { \$_.CommandLine -like '*brawlperf*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }" >/dev/null 2>&1
left=$(powershell.exe -NoProfile -Command "(Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Where-Object { \$_.CommandLine -like '*brawlperf*' } | Measure-Object).Count" 2>/dev/null | tr -d '\r')
echo "perf edge processes left: ${left:-?}"
