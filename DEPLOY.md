# Deploying InvokeAI (jaFork)

## Prerequisites

- Dev repo at `/mnt/r/GithubDev/InvokeAI_DEV`
- Python venv activated (`.venv`)
- Node/pnpm available

## Steps

### 1. Build the frontend

```bash
cd invokeai/frontend/web
pnpm build
```

### 2. Run the deploy script

```bash
cd /mnt/r/GithubDev/InvokeAI_DEV
python scripts/local_deploy.py /mnt/p/StableDiffusion/InvokeAI_JA
```

The script will:
- Preserve runtime data (databases, outputs, models, configs, nodes, invokeai.yaml, prompt_library.json, dynamic_endpoints.json)
- Wipe and replace all project files
- Re-link the editable install in the copied .venv

### 3. Start the deployed instance

```bash
cd /mnt/p/StableDiffusion/InvokeAI_JA
./start.sh
```

## Flags

| Flag | Description |
|------|-------------|
| `--no-venv` | Skip copying .venv (you'll need to create one manually) |
| `--include-models` | Include the models/ directory (can be very large) |
| `--clean` | Wipe everything including runtime data (fresh install) |
