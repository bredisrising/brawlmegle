"""
The forge's GPU service as a private Hugging Face Docker Space (alternative to the AWS box in forge/gpu/aws.sh).

    python forge/gpu/space/deploy.py push                  # create or update the private Space (code + key secret)
    python forge/gpu/space/deploy.py hardware a100-large   # put it on a GPU (billed by the minute while it runs)
    python forge/gpu/space/deploy.py status                # build/run stage, hardware, URL
    python forge/gpu/space/deploy.py pause                 # stop paying; `hardware a100-large` brings it back

Needs `pip install huggingface_hub` and HF_TOKEN (a write token) in the env or the repo root .env. The service key
comes from FORGE_3D_KEY there too; if there is none, a new one is made and appended to that .env (never printed).
The forge then needs FORGE_3D=local, FORGE_3D_URL=<the URL `status` prints>, FORGE_3D_KEY and FORGE_3D_HF_TOKEN
(a read token for the Space).
"""
import argparse
import os
import secrets
import shutil
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
GPU = HERE.parent
ROOT = GPU.parent.parent
APP_FILES = ["server.py", "gen3d.py", "landmarks.py", "rig_blender.py", "weights.py"]


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
    ap.add_argument("hw", nargs="?", default="a100-large", help="a100-large, l40sx1, a10g-large, ... (for `hardware`)")
    ap.add_argument("--repo", help="owner/name (default: <your user>/brawlegle-forge3d)")
    ap.add_argument("--env", default=str(ROOT / ".env"), help="where HF_TOKEN and FORGE_3D_KEY live")
    ap.add_argument("--sleep", type=int, default=None, help="seconds idle before the Space sleeps (paid hardware)")
    args = ap.parse_args()

    from huggingface_hub import HfApi

    env_path = Path(args.env)
    env = read_env(env_path)
    token = os.environ.get("HF_TOKEN") or env.get("HF_TOKEN")
    if not token:
        sys.exit(f"HF_TOKEN is not set (env or {env_path})")
    api = HfApi(token=token)
    repo = args.repo or f"{api.whoami()['name']}/brawlegle-forge3d"

    if args.action == "push":
        api.create_repo(repo, repo_type="space", space_sdk="docker", private=True, exist_ok=True)
        with tempfile.TemporaryDirectory() as tmp:
            for f in ["Dockerfile", "README.md"]:
                shutil.copy(HERE / f, tmp)
            for f in APP_FILES:
                shutil.copy(GPU / f, tmp)
            api.upload_folder(folder_path=tmp, repo_id=repo, repo_type="space", commit_message="forge3d: update from brawlegle forge/gpu")
        key = os.environ.get("FORGE_3D_KEY") or env.get("FORGE_3D_KEY")
        if not key:
            key = secrets.token_hex(24)
            with env_path.open("a") as f:
                f.write(f"\nFORGE_3D_KEY={key}\n")
            print(f"new service key appended to {env_path} as FORGE_3D_KEY")
        api.add_space_secret(repo, "FORGE3D_KEY", key)
        print(f"pushed {repo} (private); it builds now. Next: deploy.py hardware a100-large")
    elif args.action == "hardware":
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
