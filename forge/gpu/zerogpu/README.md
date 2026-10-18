---
title: Brawlegle Forge 3D
colorFrom: red
colorTo: gray
sdk: gradio
sdk_version: 6.1.0
python_version: 3.12
app_file: app.py
pinned: false
startup_duration_timeout: 1h
---

# Brawlegle forge 3D (ZeroGPU)

Private API for the Brawlegle forge: a fighter's model sheet in, a textured, Mixamo-rigged GLB out (TRELLIS.2 on
ZeroGPU, then MediaPipe + Blender on the CPU). Same code as `forge/gpu` in the game's repo, plus Microsoft's
`trellis2` package and FlexGEMM autotune cache from their TRELLIS.2 Space. Calls need the caller's HF token; GPU time
counts against the caller's ZeroGPU quota.
