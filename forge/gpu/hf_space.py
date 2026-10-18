"""
The forge's GPU service as a private Hugging Face Space, the alternative to the AWS box (forge/gpu/aws.sh):

  zerogpu  Gradio Space on ZeroGPU (shared GPUs, free with PRO; GPU time counts against the caller's daily quota).
           The forge talks to it with FORGE_3D=gradio.
  docker   Docker Space on dedicated hardware (a100-large, l40sx1, ...; billed by the minute while it runs). Same
           job API as the AWS box: FORGE_3D=local.

    python forge/gpu/hf_space.py push --variant zerogpu     # create or update the private Space (code + key secret)
    python forge/gpu/hf_space.py hardware zero-a10g          # ZeroGPU (or a100-large etc. for the docker variant)
    python forge/gpu/hf_space.py status                      # build/run stage, hardware, the URL for FORGE_3D_URL
    python forge/gpu/hf_space.py pause                       # stop it (paid hardware stops billing)

Needs `pip install huggingface_hub` and HF_TOKEN (a write token) in the env or the repo root .env. The service key is
FORGE_3D_KEY from there too; if there is none, a new one is appended to that .env (never printed).
"""
import argparse
import os
import secrets
import shutil
import sys
import tempfile
from pathlib import Path

GPU = Path(__file__).resolve().parent
ROOT = GPU.parent.parent
APP_FILES = ["server.py", "gen3d.py", "landmarks.py", "rig_blender.py", "weights.py"]
VARIANTS = {
    "zerogpu": {"dir": GPU / "zerogpu", "sdk": "gradio", "files": ["app.py", "requirements.txt", "packages.txt", "README.md"], "repo": "brawlegle-forge3d-zero"},
    "docker": {"dir": GPU / "docker-space", "sdk": "docker", "files": ["Dockerfile", "README.md"], "repo": "brawlegle-forge3d"},
}


def read_env(path: Path) -> dict:
    out = {}
    if path.exists():
        for line in path.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("action", choices=["push", "hardware", "status", "pause", "restart"])
    ap.add_argument("hw", nargs="?", help="for `hardware`: zero-a10g (ZeroGPU), a100-large, l40sx1, a10g-large, ...")
    ap.add_argument("--variant", choices=list(VARIANTS), default="zerogpu")
    ap.add_argument("--repo", help="owner/name (default: <your user>/brawlegle-forge3d[-zero])")
    ap.add_argument("--env", default=str(ROOT / ".env"), help="where HF_TOKEN and FORGE_3D_KEY live")
    ap.add_argument("--sleep", type=int, default=None, help="seconds idle before the Space sleeps")
    args = ap.parse_args()
    variant = VARIANTS[args.variant]

    from huggingface_hub import HfApi, snapshot_download

    env_path = Path(args.env)
    env = read_env(env_path)
    token = os.environ.get("HF_TOKEN") or env.get("HF_TOKEN")
    if not token:
        sys.exit(f"HF_TOKEN is not set (env or {env_path})")
    api = HfApi(token=token)
    repo = args.repo or f"{api.whoami()['name']}/{variant['repo']}"

    if args.action == "push":
        api.create_repo(repo, repo_type="space", space_sdk=variant["sdk"], private=True, exist_ok=True)
        with tempfile.TemporaryDirectory() as tmp:
            for f in variant["files"]:
                shutil.copy(variant["dir"] / f, tmp)
            for f in APP_FILES:
                shutil.copy(GPU / f, tmp)
            if args.variant == "zerogpu":
                # Microsoft's trellis2 package and FlexGEMM autotune cache, as tested on ZeroGPU in their own Space.
                snapshot_download("microsoft/TRELLIS.2", repo_type="space", allow_patterns=["trellis2/**", "autotune_cache.json"], local_dir=tmp, token=token)
                shutil.rmtree(Path(tmp) / ".cache", ignore_errors=True)
            api.upload_folder(folder_path=tmp, repo_id=repo, repo_type="space", commit_message="forge3d: update from brawlegle forge/gpu")
        key = os.environ.get("FORGE_3D_KEY") or env.get("FORGE_3D_KEY")
        if not key:
            key = secrets.token_hex(24)
            with env_path.open("a") as f:
                f.write(f"\nFORGE_3D_KEY={key}\n")
            print(f"new service key appended to {env_path} as FORGE_3D_KEY")
        api.add_space_secret(repo, "FORGE3D_KEY", key)
        print(f"pushed {repo} (private, {variant['sdk']}); it builds now")
    elif args.action == "hardware":
        if not args.hw:
            sys.exit("which hardware? zero-a10g, a100-large, l40sx1, ...")
        api.request_space_hardware(repo, args.hw, sleep_time=args.sleep)
        print(f"requested {args.hw} for {repo}")
    elif args.action == "pause":
        api.pause_space(repo)
        print(f"paused {repo}")
    elif args.action == "restart":
        api.restart_space(repo)
        print(f"restarting {repo}")
    rt = api.get_space_runtime(repo)
    host = getattr(api.space_info(repo), "host", None) or f"https://{repo.replace('/', '-').replace('_', '-').replace('.', '-').lower()}.hf.space"
    print(f"stage {rt.stage}, hardware {rt.hardware} (requested {rt.requested_hardware}), sleep {rt.sleep_time}")
    print(f"FORGE_3D_URL={host}")


if __name__ == "__main__":
    main()
