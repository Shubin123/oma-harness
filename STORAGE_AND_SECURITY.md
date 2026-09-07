# OMA Safe Storage, Security & Flushing Architecture

This document provides a complete guide to how OMA (Open Multi Agent) stores credentials and task memories, the cryptographic and file-system mechanisms used to safeguard sensitive data, how to inspect storage status, and how to safely flush and delete all sensitive information.

---

## 1. Storage Locations Overview

OMA stores data in two primary locations on the local system:

| Store | Location | Content | File Permissions | Dir Permissions |
|---|---|---|---|---|
| **Credentials Store** | `~/.oma/credentials.json` | Encrypted provider credentials (API keys and browser session cookies/tokens) | `0600` (`-rw-------`) | `0700` (`drwx------`) |
| **Persistent Task Memory** | `.oma_memory/*.json` (per project) | Task execution checkpoints, working memory states, and handoff summaries | `0600` (`-rw-------`) | `0700` (`drwx------`) |
| **Test History** | `tests/.history/runs.json` | Test execution timestamps, durations, and pass/fail counts (no secrets) | Standard user file | Standard dir |

> [!IMPORTANT]
> Neither API keys nor session cookies are ever written to git repositories, test artifacts, or logs. The root `.gitignore` explicitly excludes `.oma/`, `credentials.json`, `.oma_memory/`, and environment secrets.

---

## 2. Encryption & Security Architecture

### Key Derivation
- Key derivation uses **PBKDF2-HMAC-SHA256** with **100,000 iterations**, producing a 32-byte key salted with `"oma-credential-store"`.
- The machine identifier is derived from local hardware information:
  - **macOS**: Hardware UUID via `ioreg -rd1 -c IOPlatformExpertDevice` (`IOPlatformUUID`).
  - **Linux**: System machine ID via `/etc/machine-id` or `/var/lib/dbus/machine-id`.
  - **Fallback**: Composite string `{hostname}:{username}`.

### Disk Obfuscation & Atomic Writes
- Stored credentials are obfuscated via stream XOR with the derived key and base64 encoded into a versioned JSON envelope (`{"data": "...", "v": 1}`).
- **Atomic Replacement**: To eliminate partial writes or race conditions between multiple agents, updates are written to a mode `0600` temporary file (`.credentials-<pid>.tmp`) in `~/.oma/` and atomically swapped into place via `os.replace` (Python) or `fs.renameSync` (Node.js).
- **Permission Enforcement**: Both directory `0700` and file `0600` permissions are enforced programmatically upon every initialization, automatically tightening any legacy permissions.

---

## 3. Supported Credential Types & Auto-Detection

OMA supports both standard API keys and browser subscription sessional keys:

1. **Sessional Cookies / Tokens** (`auth_type: "cookie"` or `"token"`):
   - **Claude**: `sessionKey=sk-ant-sid01-...`
   - **ChatGPT**: `__Secure-next-auth.session-token=...` or OAuth JWT (`eyJ...`)
   - **Gemini**: `__Secure-1PSID=...`
2. **API Keys** (`auth_type: "api_key"`):
   - Claude: `sk-ant-api03-...`
   - ChatGPT: `sk-proj-...` or `sk-...`
   - Gemini: `AIzaSy...`
   - DeepSeek: `sk-...`
   - GLM / Kimi: standard bearer tokens

### Token Sanitization (`clean_token` / `cleanToken`)
All keys are automatically scrubbed upon entry:
- Strips surrounding quotes, whitespace, and `Bearer ` prefixes.
- Strips cookie name prefixes (`sessionKey=`, `__Secure-1PSID=`, etc.).
- Strips trailing cookie attributes (`; Domain=...; Path=/; Secure; HttpOnly`).

---

## 4. Inspection & Audit Capabilities

Users and agents can audit safe storage at any time without exposing raw secret values.

### Via Command Line Interface (CLI)

#### Python CLI (`oma`)
```bash
# Show exact storage paths, file permissions, encryption algorithm, and masked tokens
oma auth info

# List configured credentials and subscription plans
oma auth status
oma auth list

# List stored task IDs in persistent memory
oma memory list
```

#### TypeScript CLI (`oma-ts`)
```bash
node dist/cli.js auth info
node dist/cli.js auth status
node dist/cli.js memory list
```

Example output of `oma auth info`:
```text
OMA Safe Storage Information:
  Credentials File:    /Users/username/.oma/credentials.json
  Directory:           /Users/username/.oma
  File Exists:         True
  File Size:           308 bytes
  File Mode:           0o600 (owner-only: rw-------)
  Directory Mode:      0o700 (owner-only: rwx------)
  Encryption:          PBKDF2-HMAC-SHA256 (100k rounds) + Hardware UUID key + XOR stream
  Stored Providers:    1
    - deepseek: type=api_key [sk-3...f225]

How to delete:
  - Single provider:   oma auth remove <provider>
  - All credentials:   oma auth flush --all
  - All + Task memory: oma auth flush --all --include-memory
  - Manual purge:      rm -f ~/.oma/credentials.json && rm -rf .oma_memory/
```

### Via Web GUI / HTTP API
- **Web Dashboard**: The sidebar includes a dedicated **Safe Storage** card displaying active credentials file location, file mode, and a one-click **Flush Credentials** button.
- **`GET /api/storage/info`**: Returns the structured storage audit JSON.
- **`GET /api/status`**: Returns health and connection status per provider.

---

## 5. Flushing & Deletion Capabilities

Users have granular and complete control over deleting sensitive information.

### 1. Flush All Credentials from Disk
Wipes and removes `~/.oma/credentials.json`, overwriting the file with cryptographic random bytes before unlinking.

```bash
# Interactive confirmation
oma auth flush --all

# Non-interactive / CI (skip prompt)
oma auth flush --all -y

# TypeScript CLI
node dist/cli.js auth flush --all
```

### 2. Flush a Specific Provider Credential
```bash
oma auth remove claude
# or
oma auth flush --provider claude
```

### 3. Flush Credentials AND Task Memory (.oma_memory)
```bash
oma auth flush --all --include-memory -y
```

### 4. Flush Only Persistent Task Memory
```bash
# Flush all task memories
oma memory flush -y

# Flush a specific task ID
oma memory flush --task-id <task_id> -y
```

### 5. Web GUI / REST API Flush
```bash
curl -X POST http://127.0.0.1:8384/api/auth/flush \
  -H "Content-Type: application/json" \
  -d '{"include_memory": false}'
```

### 6. Programmatic Python API
```python
from oma.providers.auth import AuthManager, CredentialStore
from oma.automation.memory import PersistentMemory

# Flush all credentials
auth = AuthManager()
auth.flush(include_memory=True)

# Or directly through CredentialStore
store = CredentialStore()
store.flush(secure_wipe=True)

# Flush task memory
mem = PersistentMemory()
mem.flush()                     # Flush all tasks
mem.flush(task_id="task_123")   # Flush specific task
```

### 7. Programmatic TypeScript API
```typescript
import { AuthManager, CredentialStore } from './providers/auth.js';
import { PersistentMemory } from './automation/memory.js';

const auth = new AuthManager();
auth.flush(true); // includeMemory = true

const store = new CredentialStore();
store.flush(true);

const mem = new PersistentMemory();
mem.flush(); // Flush all tasks
```

### 8. Manual Emergency Purge
If CLI or code is inaccessible, the user can manually purge all stored data via shell:
```bash
# Wipe credentials
rm -f ~/.oma/credentials.json

# Wipe local persistent task checkpoints
rm -rf .oma_memory/
```

---

## 6. Multi-Agent Concurrency & Safe Operation

When multiple agents run concurrently or across different sub-processes:
1. **Atomic File Swaps**: Credential writes never perform partial file updates in-place. A temporary file is written and renamed, ensuring readers always see a coherent, fully encrypted file.
2. **Independent Task Checkpoints**: Persistent task memories use unique task UUIDs (`<task_id>.json`), preventing concurrent agents from clobbering each other's execution context.
3. **Graceful Fallbacks**: If credentials are flushed while an agent is running, provider requests immediately report expired/missing credentials rather than crashing.
