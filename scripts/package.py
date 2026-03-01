#!/usr/bin/env python3
"""
Package InvokeAI (jaFork) for deployment to target machines.

Creates a zip archive containing:
  - Python backend source
  - Pre-built frontend (dist/)
  - Config examples
  - Cross-platform install script

The target machine only needs Python 3.10+ and NVIDIA drivers.
No git required.

Usage:
    python scripts/package.py [--output-dir /path/to/output]
"""

import argparse
import os
import sys
import zipfile
from datetime import datetime
from pathlib import Path

# Directories/files to EXCLUDE from the package
EXCLUDE_DIRS = {
    ".git",
    ".venv",
    "node_modules",
    "models",
    "outputs",
    "databases",
    "configs",
    "__pycache__",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    "taskflowy",
    ".claude",
    ".cursor",
    "nodes",  # custom nodes - user installs their own
}

EXCLUDE_FILES = {
    ".env",
    ".env_EXAMPLE",
    "invokeai.yaml",  # user config - don't ship
    "invokeai.yaml.bak",
    "prompt_library.json",
    "dynamic_endpoints.json",
}

EXCLUDE_EXTENSIONS = {
    ".pyc",
    ".pyo",
    ".egg-info",
    ".jsonl",  # session logs
}

# Frontend: only include dist/, not source
FRONTEND_WEB = Path("invokeai/frontend/web")
FRONTEND_EXCLUDE_DIRS = {"node_modules", "src", ".storybook", "coverage", "stories"}


def should_exclude(path: Path, repo_root: Path) -> bool:
    """Check if a path should be excluded from the package."""
    rel = path.relative_to(repo_root)
    parts = rel.parts

    # Check directory exclusions
    for part in parts:
        if part in EXCLUDE_DIRS:
            return True
        if part.endswith(".egg-info"):
            return True

    # Check file exclusions
    if path.is_file():
        if path.name in EXCLUDE_FILES:
            return True
        if path.suffix in EXCLUDE_EXTENSIONS:
            return True
        # Exclude test files
        if path.name.endswith((".test.ts", ".test.tsx", ".test.py", ".test-d.ts")):
            return True

    # Frontend-specific exclusions (keep dist/, exclude src/ and node_modules/)
    if FRONTEND_WEB in rel.parents or rel == FRONTEND_WEB:
        frontend_rel = rel.relative_to(FRONTEND_WEB) if rel != FRONTEND_WEB else Path(".")
        for part in frontend_rel.parts:
            if part in FRONTEND_EXCLUDE_DIRS:
                return True

    return False


def create_install_script() -> str:
    """Generate the cross-platform install.py script content."""
    return '''#!/usr/bin/env python3
"""
InvokeAI (jaFork) Installer

Sets up a Python virtual environment and installs all dependencies.
Run this after unzipping the package on the target machine.

Requirements:
  - Python 3.10, 3.11, or 3.12
  - NVIDIA GPU with drivers installed
  - Internet connection (for pip to download dependencies)

Usage:
    python install.py
"""

import os
import platform
import shutil
import subprocess
import sys
import venv
from pathlib import Path


def check_python_version():
    """Verify Python version is compatible."""
    major, minor = sys.version_info[:2]
    if major != 3 or minor not in (10, 11, 12):
        print(f"ERROR: Python 3.10-3.12 required, found {major}.{minor}")
        sys.exit(1)
    print(f"Python {major}.{minor}.{sys.version_info[2]} - OK")


def check_nvidia():
    """Check for NVIDIA GPU (non-fatal warning)."""
    try:
        result = subprocess.run(
            ["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"],
            capture_output=True, text=True, timeout=10
        )
        if result.returncode == 0:
            gpu = result.stdout.strip().split("\\n")[0]
            print(f"NVIDIA GPU: {gpu} - OK")
            return True
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass
    print("WARNING: nvidia-smi not found. GPU acceleration may not work.")
    return False


def create_venv(venv_path: Path):
    """Create a Python virtual environment."""
    if venv_path.exists():
        print(f"Virtual environment already exists at {venv_path}")
        response = input("Recreate? (y/N): ").strip().lower()
        if response == "y":
            shutil.rmtree(venv_path)
        else:
            return

    print("Creating virtual environment...")
    venv.create(str(venv_path), with_pip=True)
    print("Virtual environment created.")


def get_pip_cmd(venv_path: Path) -> list[str]:
    """Get the pip command for the venv."""
    if platform.system() == "Windows":
        return [str(venv_path / "Scripts" / "python.exe"), "-m", "pip"]
    else:
        return [str(venv_path / "bin" / "python"), "-m", "pip"]


def get_python_cmd(venv_path: Path) -> str:
    """Get the python executable path for the venv."""
    if platform.system() == "Windows":
        return str(venv_path / "Scripts" / "python.exe")
    else:
        return str(venv_path / "bin" / "python")


def install_package(venv_path: Path, project_dir: Path):
    """Install InvokeAI into the virtual environment."""
    pip = get_pip_cmd(venv_path)

    print("Upgrading pip...")
    subprocess.run([*pip, "install", "--upgrade", "pip"], check=True)

    print("Installing InvokeAI (this may take 15-25 minutes on first install)...")
    subprocess.run([*pip, "install", "-e", str(project_dir)], check=True)
    print("Installation complete!")


def create_launcher(project_dir: Path, venv_path: Path):
    """Create launcher scripts for the target platform."""
    if platform.system() == "Windows":
        launcher = project_dir / "start.bat"
        launcher.write_text(
            f\'\'\'@echo off
echo Starting InvokeAI...
call "{venv_path}\\\\Scripts\\\\activate.bat"
cd /d "{project_dir}"
invokeai-web
pause
\'\'\'
        )
        print(f"Launcher created: {launcher}")
    else:
        launcher = project_dir / "start.sh"
        launcher.write_text(
            f\'\'\'#!/bin/bash
echo "Starting InvokeAI..."
source "{venv_path}/bin/activate"
cd "{project_dir}"
invokeai-web
\'\'\'
        )
        launcher.chmod(0o755)
        print(f"Launcher created: {launcher}")


def main():
    print("=" * 50)
    print("InvokeAI (jaFork) Installer")
    print("=" * 50)
    print()

    project_dir = Path(__file__).parent.resolve()
    venv_path = project_dir / ".venv"

    check_python_version()
    check_nvidia()
    print()

    create_venv(venv_path)
    print()

    install_package(venv_path, project_dir)
    print()

    create_launcher(project_dir, venv_path)
    print()

    print("=" * 50)
    print("Installation complete!")
    print()
    if platform.system() == "Windows":
        print("To start InvokeAI, run: start.bat")
        print(f"Or: {venv_path}\\\\Scripts\\\\activate.bat && invokeai-web")
    else:
        print("To start InvokeAI, run: ./start.sh")
        print(f"Or: source {venv_path}/bin/activate && invokeai-web")
    print("=" * 50)


if __name__ == "__main__":
    main()
'''


def create_package(repo_root: Path, output_dir: Path) -> Path:
    """Create the deployment zip package."""
    timestamp = datetime.now().strftime("%Y%m%d-%H%M")
    zip_name = f"invokeai_jaFork_{timestamp}.zip"
    zip_path = output_dir / zip_name

    # Verify frontend is built
    dist_dir = repo_root / FRONTEND_WEB / "dist"
    if not dist_dir.exists() or not (dist_dir / "index.html").exists():
        print("ERROR: Frontend not built. Run 'pnpm build' from invokeai/frontend/web/ first.")
        sys.exit(1)

    print(f"Creating package: {zip_name}")
    print(f"Source: {repo_root}")
    print(f"Output: {zip_path}")
    print()

    file_count = 0
    skipped_count = 0

    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        # Add install script
        zf.writestr("install.py", create_install_script())
        file_count += 1

        # Walk the repo and add files
        for root, dirs, files in os.walk(repo_root):
            root_path = Path(root)

            # Prune excluded directories (modifying dirs in-place)
            dirs[:] = [
                d for d in dirs
                if not should_exclude(root_path / d, repo_root)
            ]

            for filename in files:
                file_path = root_path / filename
                if should_exclude(file_path, repo_root):
                    skipped_count += 1
                    continue

                arcname = file_path.relative_to(repo_root)
                zf.write(file_path, arcname)
                file_count += 1

                if file_count % 500 == 0:
                    print(f"  {file_count} files added...")

    size_mb = zip_path.stat().st_size / (1024 * 1024)
    print()
    print(f"Package created: {zip_path}")
    print(f"  Files included: {file_count}")
    print(f"  Files skipped:  {skipped_count}")
    print(f"  Size: {size_mb:.1f} MB")

    return zip_path


def main():
    parser = argparse.ArgumentParser(description="Package InvokeAI for deployment")
    parser.add_argument(
        "--output-dir", "-o",
        type=Path,
        default=None,
        help="Output directory for the zip file (default: repo root)",
    )
    args = parser.parse_args()

    repo_root = Path(__file__).parent.parent.resolve()
    output_dir = args.output_dir or repo_root

    if not (repo_root / "pyproject.toml").exists():
        print("ERROR: Must be run from the InvokeAI repository")
        sys.exit(1)

    output_dir.mkdir(parents=True, exist_ok=True)
    create_package(repo_root, output_dir)


if __name__ == "__main__":
    main()
