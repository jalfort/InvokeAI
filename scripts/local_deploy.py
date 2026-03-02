#!/usr/bin/env python3
"""
Deploy InvokeAI (jaFork) to a local directory for battle testing.

Copies the project INCLUDING the .venv (so no rebuild needed),
strips dev-only files, and re-links the editable install.

Usage:
    python scripts/local_deploy.py /mnt/other_drive/InvokeAI
    python scripts/local_deploy.py D:\\InvokeAI
"""

import argparse
import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path

# Dev-only directories to strip from the copy
STRIP_DIRS = {
    ".git",
    "node_modules",
    "__pycache__",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    "taskflowy",
    ".claude",
    ".cursor",
    "docs",
}

# Frontend dev files to strip (keep dist/ only)
FRONTEND_STRIP_DIRS = {"src", ".storybook", "coverage", "stories"}

# Dev-only files to strip
STRIP_FILES = {
    ".env_EXAMPLE",
    "invokeai.yaml.bak",
}

STRIP_EXTENSIONS = {
    ".pyc",
    ".pyo",
    ".jsonl",
}

# Runtime data to preserve across re-deploys (dirs and files at dest root)
RUNTIME_PRESERVE_DIRS = {
    "databases",
    "outputs",
    "models",
    "configs",
    "nodes",
}

RUNTIME_PRESERVE_FILES = {
    "invokeai.yaml",
    "prompt_library.json",
    "dynamic_endpoints.json",
}


def get_size_mb(path: Path) -> float:
    """Get total size of a directory in MB."""
    total = 0
    for f in path.rglob("*"):
        if f.is_file():
            total += f.stat().st_size
    return total / (1024 * 1024)


def _stash_runtime(dest: Path) -> Path | None:
    """Move runtime data to a temp dir before wiping destination."""
    stash = dest.parent / f".deploy_stash_{dest.name}"
    found_any = False

    for dirname in RUNTIME_PRESERVE_DIRS:
        src_dir = dest / dirname
        if src_dir.exists():
            stash.mkdir(parents=True, exist_ok=True)
            print(f"  Preserving {dirname}/")
            shutil.move(str(src_dir), str(stash / dirname))
            found_any = True

    for filename in RUNTIME_PRESERVE_FILES:
        src_file = dest / filename
        if src_file.exists():
            stash.mkdir(parents=True, exist_ok=True)
            print(f"  Preserving {filename}")
            shutil.move(str(src_file), str(stash / filename))
            found_any = True

    return stash if found_any else None


def _restore_runtime(dest: Path, stash: Path):
    """Move stashed runtime data back into the destination."""
    for item in stash.iterdir():
        target = dest / item.name
        if target.exists():
            # Source repo had a copy (e.g. invokeai.yaml) — runtime version wins
            if target.is_dir():
                shutil.rmtree(target)
            else:
                target.unlink()
        shutil.move(str(item), str(target))
        print(f"  Restored {item.name}")
    stash.rmdir()


def copy_project(src: Path, dest: Path, include_venv: bool = True, clean: bool = False):
    """Copy project files, excluding dev-only content."""
    stash = None
    if dest.exists():
        print(f"WARNING: Destination already exists: {dest}")
        response = input("Overwrite? (y/N): ").strip().lower()
        if response != "y":
            print("Aborted.")
            sys.exit(0)

        # Stash runtime data before wiping
        if not clean:
            print("Preserving runtime data...")
            stash = _stash_runtime(dest)

        print("Removing existing destination...")
        shutil.rmtree(dest)

    print(f"Copying project to {dest}...")
    print("(This may take a few minutes for the .venv)")

    file_count = 0
    skipped_count = 0

    for root, dirs, files in os.walk(src):
        root_path = Path(root)
        rel_root = root_path.relative_to(src)

        # Check if this directory should be stripped
        should_skip_dir = False
        for part in rel_root.parts:
            if part in STRIP_DIRS:
                should_skip_dir = True
                break
            if part.endswith(".egg-info"):
                should_skip_dir = True
                break

        if should_skip_dir:
            dirs.clear()
            skipped_count += 1
            continue

        # Skip .venv if not including it
        if not include_venv and ".venv" in rel_root.parts:
            dirs.clear()
            skipped_count += 1
            continue

        # Frontend: strip src/, node_modules, etc. (keep dist/)
        frontend_web = Path("invokeai/frontend/web")
        if str(rel_root).startswith(str(frontend_web)):
            frontend_rel = rel_root.relative_to(frontend_web)
            for part in frontend_rel.parts:
                if part in FRONTEND_STRIP_DIRS:
                    should_skip_dir = True
                    break

        if should_skip_dir:
            dirs.clear()
            skipped_count += 1
            continue

        # Prune directories to avoid walking into excluded ones
        dirs[:] = [
            d for d in dirs
            if d not in STRIP_DIRS
            and not d.endswith(".egg-info")
            and not (not include_venv and d == ".venv")
        ]

        # Copy files
        dest_dir = dest / rel_root
        dest_dir.mkdir(parents=True, exist_ok=True)

        for filename in files:
            file_path = root_path / filename

            # Skip dev-only files
            if filename in STRIP_FILES:
                skipped_count += 1
                continue
            if any(filename.endswith(ext) for ext in STRIP_EXTENSIONS):
                skipped_count += 1
                continue
            # Skip test files
            if filename.endswith((".test.ts", ".test.tsx", ".test.py", ".test-d.ts")):
                skipped_count += 1
                continue

            dest_file = dest_dir / filename
            shutil.copy2(file_path, dest_file)
            file_count += 1

            if file_count % 2000 == 0:
                print(f"  {file_count} files copied...")

    print(f"  {file_count} files copied, {skipped_count} skipped")

    # Restore stashed runtime data
    if dest.exists() and stash is not None and stash.exists():
        print()
        print("Restoring runtime data...")
        _restore_runtime(dest, stash)

    return file_count


def fix_venv_editable(dest: Path):
    """Re-link the editable install to point to the new location."""
    if platform.system() == "Windows":
        python = dest / ".venv" / "Scripts" / "python.exe"
    else:
        python = dest / ".venv" / "bin" / "python"

    if not python.exists():
        print("WARNING: No .venv found. You'll need to create one and install dependencies.")
        return

    print("Re-linking editable install to new location...")
    result = subprocess.run(
        [str(python), "-m", "pip", "install", "-e", str(dest), "--no-deps"],
        capture_output=True,
        text=True,
    )
    if result.returncode == 0:
        print("Editable install re-linked successfully.")
    else:
        print(f"WARNING: Failed to re-link: {result.stderr}")
        print("You may need to run: pip install -e . manually from the new location.")


def create_launcher(dest: Path):
    """Create a launcher script at the destination."""
    venv_path = dest / ".venv"

    if platform.system() == "Windows":
        launcher = dest / "start.bat"
        launcher.write_text(
            f"""@echo off
echo Starting InvokeAI...
call "{venv_path}\\Scripts\\activate.bat"
cd /d "{dest}"
invokeai-web
pause
"""
        )
        print(f"Launcher: {launcher}")
    else:
        launcher = dest / "start.sh"
        launcher.write_text(
            f"""#!/bin/bash
echo "Starting InvokeAI..."
source "{venv_path}/bin/activate"
cd "{dest}"
invokeai-web
"""
        )
        launcher.chmod(0o755)
        print(f"Launcher: {launcher}")


def main():
    parser = argparse.ArgumentParser(
        description="Deploy InvokeAI to a local directory for battle testing"
    )
    parser.add_argument(
        "destination",
        type=Path,
        help="Target directory (e.g., /mnt/other_drive/InvokeAI or D:\\InvokeAI)",
    )
    parser.add_argument(
        "--no-venv",
        action="store_true",
        help="Don't copy .venv (you'll need to create one at the destination)",
    )
    parser.add_argument(
        "--include-models",
        action="store_true",
        help="Include models/ directory (can be very large)",
    )
    parser.add_argument(
        "--clean",
        action="store_true",
        help="Wipe everything at destination (don't preserve runtime data)",
    )
    args = parser.parse_args()

    repo_root = Path(__file__).parent.parent.resolve()
    dest = args.destination.resolve()

    if not (repo_root / "pyproject.toml").exists():
        print("ERROR: Must be run from the InvokeAI repository")
        sys.exit(1)

    # Verify frontend is built
    dist_dir = repo_root / "invokeai" / "frontend" / "web" / "dist"
    if not dist_dir.exists() or not (dist_dir / "index.html").exists():
        print("ERROR: Frontend not built. Run 'pnpm build' from invokeai/frontend/web/ first.")
        sys.exit(1)

    # Add models to strip list if not including
    if not args.include_models:
        STRIP_DIRS.add("models")

    print("=" * 50)
    print("InvokeAI Local Deploy")
    print("=" * 50)
    print(f"Source:      {repo_root}")
    print(f"Destination: {dest}")
    print(f"Include venv: {'yes' if not args.no_venv else 'no'}")
    print(f"Include models: {'yes' if args.include_models else 'no'}")
    print(f"Preserve runtime: {'no (--clean)' if args.clean else 'yes'}")
    print()

    response = input("Proceed? (y/N): ").strip().lower()
    if response != "y":
        print("Aborted.")
        sys.exit(0)

    print()
    copy_project(repo_root, dest, include_venv=not args.no_venv, clean=args.clean)

    print()
    if not args.no_venv:
        fix_venv_editable(dest)

    print()
    create_launcher(dest)

    print()
    print("=" * 50)
    print("Deploy complete!")
    print()
    if not args.no_venv:
        if platform.system() == "Windows":
            print(f"To start: {dest}\\start.bat")
        else:
            print(f"To start: {dest}/start.sh")
    else:
        print("Next steps:")
        print(f"  cd {dest}")
        print("  python -m venv .venv")
        print("  pip install -e .")
    print("=" * 50)


if __name__ == "__main__":
    main()
