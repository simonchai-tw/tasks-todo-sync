# bootstrap.sh — verification plan for a Linux test environment

Status: **UNVERIFIED on real POSIX systems outside Windows Git Bash.**
The author has no macOS device and the dev sandbox cannot spawn `wsl.exe`.
This document hands the script to a Linux-capable reviewer (human or AI with a
real Linux VM / container) together with the exact cases to run and the exact
expected outcomes. The macOS-only branches (Homebrew) cannot be verified on
Linux; they are listed as inspect-only.

## 1. What is being verified

| Item | Value |
|---|---|
| File | `bootstrap.sh` (repo root) |
| Commit | `816197e` — `0.9.5-alpha: one-command Mac/Linux bootstrap + website stat card single-sourced (advisory P1)` |
| SHA-256 | `1da7bbdb8cc7fefaada1d2b569c11141e0f283e9985c2a9a003f69194f6506e0` |
| Interpreter | POSIX `sh` (must run under `dash`, `bash --posix`, BusyBox sh) |
| Purpose | One-command onboarding: check Node.js >= 22 + npm/npx, install what is missing via a supported route, then hand over to `npx tasks-todo-sync init` |

## 2. Design contract (what MUST hold)

1. **Node version single source**: `NODE_MIN_MAJOR=22` in the script must equal
   the major in `package.json` → `"engines": { "node": ">=22" }`. A regression
   test (`tests/bootstrap.test.mjs`) asserts this; both sides must move together.
2. **Never assumes Homebrew exists** (macOS): missing brew → offers official
   Homebrew installer OR the nodejs.org package; never hard-fails into brew.
3. **Fail-closed without a TTY**: when stdin is the piped script
   (`curl ... | sh`) and `/dev/tty` is unavailable (CI, non-interactive shell),
   every interactive path must print instructions and `exit 1` — never guess,
   never hang, never consume the script itself as input.
4. **No silent sudo**: the Linux route prefers nvm (user-space); distro
   package-manager commands are printed for the user to run, not auto-executed.
5. **Continues the same flow**: environment OK ⇒ `exec npx -y
   tasks-todo-sync@${TTS_VERSION:-latest} init "$@"` — the user is never
   dropped back at docs.
6. **Windows guard**: non-Darwin/Linux `uname` prints the Windows installer
   pointer and exits 1.

Already verified (statically / on Windows Git Bash):

- `sh -n bootstrap.sh` → exit 0.
- All 6 assertions in `tests/bootstrap.test.mjs` pass (file present, engines
  sync, no-brew branch, /dev/tty fallback, `exec npx ... init`, `sh -n`).
- Path-handling gotcha fixed: tests must pass `sh` a forward-slash path.

Known dev-sandbox limitation (not a script defect): `spawnSync('sh', ...)`
fails with EBUSY inside the author's sandbox; the `sh -n` test skips itself
there. On normal Linux it runs.

## 3. Environment needed

- Any Linux VM/container with `sh` and `curl` (Debian/Ubuntu or Fedora fine).
- At least one case needs **no `node` on PATH** (clean container is ideal).
- One case needs a **faked node** (see T3) — no real install required.
- Network only needed if you actually exercise the nvm install branch (T5).

Copy the script into the VM (`scp`, paste, or `curl` the raw file from the
repo) and `cd` to its directory. Confirm the checksum first:

```sh
sha256sum bootstrap.sh
# expect: 1da7bbdb8cc7fefaada1d2b569c11141e0f283e9985c2a9a003f69194f6506e0
```

## 4. Test cases

### T1 — Syntax (dash + bash)

```sh
dash -n bootstrap.sh; echo "dash exit=$?"
bash -n bootstrap.sh; echo "bash exit=$?"
```

Expected: both `exit=0`, no output. Fail if either reports a syntax error.

### T2 — Clean environment, no node, no TTY (fail-closed path)

In a container WITHOUT node, run detached from any tty:

```sh
sh bootstrap.sh < /dev/null; echo "exit=$?"
```

Expected:
- prints `Node.js >= 22 was not found.`
- prints the Linux options block (`[1] Install Node.js via nvm ...`)
- since no interactive input is available: prints
  `No interactive input available. Install Node.js >= 22 (e.g. via nvm), then re-run.`
- `exit=1`.

**Must not hang.** A hang is a P0 failure of contract #3.

### T3 — Environment-OK path without really installing (fake node/npm/npx)

Verify the handover command is assembled correctly, without network:

```sh
mkdir -p /tmp/fakebin
for t in node npm npx; do
  printf '#!/bin/sh\necho "FAKE %s args: $*" >&2\nexit 0\n' "$t" > /tmp/fakebin/$t
  chmod +x /tmp/fakebin/$t
done
# fake node must report a major version >= 22
cat > /tmp/fakebin/node <<'EOF'
#!/bin/sh
case "$1" in
  -p*) echo 22 ;;
  -v*) echo "v22.11.0" ;;
  *)   echo 22 ;;
esac
EOF
chmod +x /tmp/fakebin/node

PATH=/tmp/fakebin sh bootstrap.sh < /dev/null; echo "exit=$?"
```

Expected:
- prints `Node.js v22.11.0 with npm found. OK.`
- prints `Environment ready (node v22.11.0). Starting the guided setup...`
- the fake `npx` prints `FAKE npx args: -y tasks-todo-sync@latest init`
- then `exec` replaces the shell with npx; final `exit=0` (from the fake).

If the args are wrong (missing `-y`, wrong package name, missing `init`,
dropped pass-through args), that is a failure — the real run would open the
wrong flow.

Also verify version pinning: `TTS_VERSION=0.9.5-alpha PATH=/tmp/fakebin sh
bootstrap.sh` must produce `tasks-todo-sync@0.9.5-alpha`.

And verify pass-through: `PATH=/tmp/fakebin sh bootstrap.sh --help` must end
with `... init --help`.

### T4 — Node present but too old / npm missing

```sh
mkdir -p /tmp/oldbin
cat > /tmp/oldbin/node <<'EOF'
#!/bin/sh
[ "$1" = -p ] && { echo 18; exit 0; }
echo "v18.19.0"
EOF
chmod +x /tmp/oldbin/node
PATH=/tmp/oldbin sh bootstrap.sh < /dev/null; echo "exit=$?"
```

Expected: prints `Node.js v18 is too old (need >= 22).`, then the options
block, then the no-TTY fail-closed line, `exit=1`.

(For "node present but npm/npx missing": extend the fake so `npm`/`npx` do not
exist on PATH — expected message: `Node.js was found but npm/npx is missing.`)

### T5 — Real install branch (optional, needs network)

Only if you accept the VM being modified:

```sh
sh bootstrap.sh    # interactive; choose [1] nvm
```

Expected: nvm v0.40.1 installs into `~/.nvm`, node 22 installs, the script
re-checks and continues into `npx tasks-todo-sync@latest init` (you can stop
here — the init flow itself is out of scope for this verification).

Note: nvm is installed for **new** shells; if the current shell cannot see
node after install, the script must print "Open a new terminal and re-run"
and exit 1 (contract: never push on with a broken environment).

### T6 — Windows guard (inspect-only)

Static check: `case "$(uname -s)"` has a `*)` branch printing the Windows
installer pointer (`https://github.com/simonchai-tw/tasks-todo-sync/releases`)
and exiting 1. Not runnable on Linux (WSL reports `Linux` on purpose — that is
correct: the script must treat WSL as Linux).

### T7 — macOS branches (inspect-only; needs a real Mac, tracked separately)

- `brew` present → offers `brew install node`, y/N prompt.
- `brew` absent → `[1]` Homebrew official installer (with
  `/opt/homebrew` vs `/usr/local` shellenv eval) or `[2]` nodejs.org + re-run.
- No-TTY: both paths print instructions and exit 1.

## 5. Report format

For each case: PASS/FAIL, the actual output, and one line on why. Any FAIL on
T1–T4 blocks calling the bootstrap "alpha-ready". T5/T6/T7 findings are
notes, not blockers.
