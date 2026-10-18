#!/bin/bash
# Stop any Edge left from a perf run: only processes started with this tag's profile (default brawlperf), never your own Edge.
TAG=${1:-brawlperf}
powershell.exe -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Where-Object { \$_.CommandLine -like '*$TAG*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }" >/dev/null 2>&1
left=$(powershell.exe -NoProfile -Command "(Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Where-Object { \$_.CommandLine -like '*$TAG*' } | Measure-Object).Count" 2>/dev/null | tr -d '\r')
echo "perf edge processes left: ${left:-?}"
