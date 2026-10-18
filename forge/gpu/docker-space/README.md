---
title: Brawlegle Forge 3D
colorFrom: red
colorTo: gray
sdk: docker
app_port: 7860
pinned: false
startup_duration_timeout: 1h
---

# Brawlegle forge 3D

Private service for the Brawlegle forge: a fighter's model sheet in, a textured, Mixamo-rigged GLB out
(TRELLIS.2 + MediaPipe + Blender). It's the same code as `forge/gpu` in the game's repo; see its README for the API.
Every call needs the Space's HF token (`Authorization: Bearer`) and the service key (`x-forge3d-key`, the
`FORGE3D_KEY` secret).
