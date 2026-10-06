# Tandem — development guide

[Русский](README_DEV.ru.md) · **English**

User documentation lives in [README.md](README.md). This file covers only what you need to work on the plugin itself: architecture, internals, tests, publishing.

---

## Architecture

The plugin implements neither OAuth nor HTTP clients to any model. All communication with GPT goes through the local `codex` CLI; all communication with Claude from the reverse direction goes through `claude -p`. That's deliberate: tokens stay in the stores the official tools put them in, and the plugin never becomes one more place someone else's secret can leak from.

Three channels:

| Channel | Mechanism | Declared in |
|---|---|---|
| Claude → GPT | MCP server `codex` | `.mcp.json` |
| Claude → images | MCP server `image` | `.mcp.json` |
| GPT → Claude | MCP server `claude-bridge` | `~/.codex/config.toml` |

No external dependencies. Both MCP servers and the MCP client implement JSON-RPC over stdio using only the Node standard library.

## Layout

```
tandem/
├── .claude-plugin/
│   ├── plugin.json          manifest, userConfig, defaultEnabled: false
│   └── marketplace.json     single-plugin catalog, source: "."
├── .mcp.json                registers the codex and image servers
├── commands/                slash commands (including research, brainstorm, custom)
├── agents/                  gpt-delegate, gpt-advisor, gpt-chat, image-smith
├── hooks/hooks.json         SessionStart → preflight
├── .github/workflows/       tests.yml: matrix (Linux/Windows × Node 20.11/22) + strict validate
├── scripts/
│   ├── mcp-lib.mjs          MCP transport (server side): JSON-RPC over stdio
│   ├── codex-core.mjs       codex exec wrapper, capabilities, job manager
│   ├── job-worker.mjs       one process per Codex run, both backends
│   ├── app-server.mjs       JSON-RPC client for codex app-server (native review)
│   ├── proc.mjs             portable process-tree termination
│   ├── chat-store.mjs       conversation threads, per-thread lock
│   ├── prefs.mjs            default model and effort per repository
│   ├── statusline.mjs       status line: what the jobs are doing now
│   ├── mcp-codex.mjs        MCP server, Claude → GPT
│   ├── codex-health.mjs     Codex installation diagnostics, version mismatch
│   ├── codex-events.mjs     event parsing: codex exec --json and app-server
│   ├── models.mjs           model catalog: query Codex, cache, validate
│   ├── image-core.mjs       generation via the built-in image_gen tool
│   ├── mcp-image.mjs        MCP server for image generation
│   ├── link-back.mjs        safe editing of ~/.codex/config.toml
│   ├── setup.mjs            diagnostics, allowlist, link-back
│   ├── version.mjs          single source of the version: plugin.json
│   ├── i18n.mjs             outward-facing texts and prompts, en/ru
│   ├── i18n-runtime.mjs     runtime messages, en/ru
│   ├── i18n-image.mjs       image-generation texts, en/ru
│   ├── i18n-claude.mjs      reverse-bridge texts, en/ru
│   └── preflight.mjs        SessionStart hook, bridge path self-healing
├── bridge/
│   ├── mcp-claude.mjs       MCP server, GPT → Claude
│   ├── mcp-client.mjs       MCP client for connecting to Claude's servers
│   └── tool-proxy.mjs       allowlist, server discovery, re-export
└── tests/regressions.mjs    119 regression tests
```

---

### Three different names

They're easy to confuse, and they do different things:

| What | Value | What it affects |
|---|---|---|
| Repository | `tandem` | `/plugin marketplace add VlDubr/tandem` |
| Marketplace (`marketplace.json` → `name`) | `tandem` | the right-hand side of `tandem@tandem` |
| Plugin (`plugin.json` → `name`) | `tandem` | **the slash command and subagent prefix**: `/tandem:review`, `@tandem:gpt-advisor` |

The prefix is never optional: even when a command's name matches the plugin's, the invocation is still `/plugin:command`. So the plugin name stays short — it appears in every single command. Renaming `plugin.json` → `name` changes every command at once and breaks users' muscle memory, so only do it alongside a major version bump.

---

## Internals

### Language of outward-facing text

The plugin was written in Russian, prompts included. A Russian prompt makes both Codex and Claude answer in Russian, so for a non-Russian user this wasn't "a plugin with Russian docs" — it was a plugin that changed the language of their output. English is now the default; Russian is the `language` setting (`TANDEM_LANG=ru`).

Everything the user or the called model sees lives in the `i18n*.mjs` files: `i18n.mjs` (prompts and core texts), `i18n-runtime.mjs` (runtime messages), `i18n-image.mjs`, `i18n-claude.mjs`. `lang()` ignores an unknown value rather than failing — there is nowhere to report it from. Code comments stay Russian: the author reads them, the user doesn't.

Commands and agents are English-only: their frontmatter is what Claude Code indexes, and it is read at load time, before any setting is known.

### Detecting `codex exec` flags

The flag set changed across Codex versions: `--ask-for-approval` is absent in some builds and triggers `unexpected argument`. So flags are never guessed — `capabilities()` in `codex-core.mjs` reads `codex exec --help` once, parses which flags exist, and caches the result next to the plugin data, keyed by binary version.

All command-line assembly is confined to `buildArgs()`. If a launch fails on arguments, that's the only place to fix.

### Codex installation health

`codex-health.mjs` exists because of one concrete incident: on Windows the sandbox refused to start, because the helpers in `~/.codex/.sandbox-bin` came from 0.145–0.146-alpha while the CLI was 0.144.6. The failure surfaced as `user cancelled MCP tool call` — indistinguishable from a user aborting, or from a dead MCP server. Diagnosis went the wrong way for a while.

`inspect()` compares the CLI version against versions parsed out of the helper filenames, checks that `codex-windows-sandbox-setup.exe` exists when `[windows] sandbox` is enabled, and returns problems as *what / why / fix* rather than as bare facts. `explainCodexFailure()` recognises both the raw form and the masked one, and states explicitly that the bridge is not at fault.

`bypass_sandbox` switches `codex exec` to `--dangerously-bypass-approvals-and-sandbox`. It's off by default and gated behind capability detection: it removes isolation entirely, so it's an emergency measure while the installation is being fixed, not a configuration choice.

### Effort levels

The same class of mistake as with models — I just managed to make it twice: the `reasoning effort` set depends on the model, and a hardcoded list goes stale silently. `gpt-5.6-sol` rejects `minimal` with an API error; earlier generations accept it.

`EFFORT_LEVELS` in `models.mjs` is deliberately a wide list, used only for the MCP tool schema; the real filtering happens in `validateEffort()` against the catalog's `supported_reasoning_efforts`. As with models, the check is skipped when the catalog is incomplete: better to let a questionable value through than to reject a working one.

`explainCodexFailure()` in `codex-core.mjs` additionally turns the API response into an actionable message, pulling the supported values out of the error text. `denoise()` strips Codex's own housekeeping lines (chiefly its internal model-cache mismatch) so they can't mask the real cause.

### Progress instead of a blind timeout

`codex exec --json` streams a JSONL event feed while the agent works: `turn.started`, `item.started/updated/completed`, `turn.completed` with token usage. Item types cover reasoning, command execution, file changes, MCP tool calls, web searches and plan updates.

`codex-events.mjs` parses that feed and renders it for a human. Two details from the format matter: reasoning items only appear when reasoning summaries are enabled, and `type: "error"` carrying `Reconnecting... X/Y` is a non-fatal retry notice, not a failure — `isFatalError()` distinguishes them.

The flag is added only when capability detection finds it. Without it `extractOutput()` returns the raw text unchanged, so an older Codex degrades to the previous behaviour rather than losing the answer.

`codex_ask` does not die on timeout. It waits `wait_seconds` (90 by default) and, if the model is still working, returns the job id along with the trail collected so far. The request is **not** restarted: a separate worker process has been doing the work from the start, and waiting is just reading its log.

While the call is in flight, every meaningful event goes to the client as `notifications/progress` with a monotonic counter and the token from `_meta.progressToken`. Without a token nothing is sent — there is nowhere to address it. The reverse direction works too: `notifications/cancelled` aborts the handler through an `AbortSignal`, the job is stopped, and no response is sent for the cancelled call.

Only reasoning *summaries* leave Codex; full chain-of-thought is not exposed. With `model_reasoning_summary="auto"` there may be no summaries at all, hence the `reasoning_summary` setting.

### Two review backends

`review_backend` picks how `codex_review` runs:

| Backend | Transport | What Codex does |
|---|---|---|
| `exec` (default) | `codex exec --json` | reviews a diff we assembled and put in the prompt |
| `app-server` | `codex app-server --stdio`, JSON-RPC over stdio | its own `review/start` reviewer decides what to read |

`app-server.mjs` is a minimal JSON-RPC client: `initialize` → `initialized` → `thread/start` → `review/start`, notifications translated into the same event shape by `fromAppServerNotification()` so the trail, the log, and `codex_progress` don't care which backend produced them. Cancellation goes out as `turn/interrupt`. The protocol was checked against a live binary: `jsonrpc` is optional in its frames, and token counters arrive separately in `thread/tokenUsage/updated` — the client keeps the last `tokenUsage.total` and attaches it to `turn.completed`, otherwise usage would be missing from the native path.

Falling back to `exec` is only safe **before the request reaches Codex**. The boundary is `dispatched` — the moment the frame is written to stdin — not `accepted`, the moment a response comes back: a review that already started spends quota, and a fallback would run it twice. The one exception is an explicit JSON-RPC error (`error.rpc`): a refusal proves the review never began, so `exec` may still run.

The diff is assembled for `app-server` too, but only as material for that fallback. If assembling it fails, the native review still starts — `allowFallback: false` is recorded in the job spec, and the worker rethrows instead of silently switching backends.

### Collecting the changes

`collectDiff()` is what `exec` review sees, so gaps in it are review gaps. It gathers the diff against the merge base, staged and unstaged changes, and new untracked files, then the recent log.

The limits are deliberate and each one is announced in the output rather than applied silently: `DIFF_MAX_BYTES` 256 KB, `DIFF_MAX_FILES` 60, `DIFF_MAX_NAMES` 400, `LOG_MAX_COMMITS` 200, and for untracked files 24 KB each, 128 KB total, 25 files, text only (`isProbablyText()`).

Two refusals matter. Files that look like secrets (`SECRETISH`) are cut out of the diff with `git diff … -- . ':(exclude,literal)<path>'` and reported as hidden — passing a `.env` to another model is not a review. And when the branch has no merge base with the target, the request is refused instead of dumping the entire history as "the changes".

### Process model

One path for both synchronous and background calls:

```
MCP call ──► job-worker.mjs ──► codex exec | codex app-server ──► the job's JSONL log
                                                                       ▲
                                           followJob() reads the log ──┘ and emits progress
```

There used to be two paths, both broken. `spawnSync` blocked the MCP server's event loop for the entire Codex run — the server stopped answering `ping` and the client dropped the connection with `MCP error -32000: Connection closed`. `/bin/sh` does not exist on Windows: a background job died before its first line of output and stayed in `unknown` forever.

The worker is portable (`node job-worker.mjs`), timestamps events on receipt (Codex does not send timestamps), writes the exit code atomically, and leaves a note explaining how it ended: `timeout`, `cancelled`, `spawn_failed`, `prompt_failed`, `app_server_failed`. `reconcile()` turns that note into a status — otherwise a cancellation and a timeout would both look like a plain failed run. The process tree is killed via `taskkill /T` on Windows and via the process group on POSIX (`proc.mjs`), and `SIGTERM` escalates to `SIGKILL` after 3 s: a process that ignores the soft signal kept spending quota and editing files after the cancellation.

Order matters at both ends. The job record is written **before** `spawn`; the reverse order left a Codex process nobody knew about — invisible to accounting and to cancellation — so a failure to record it now kills the child. On completion the note and the exit code are published from inside `out.end(callback)`, after the log stream has flushed: published earlier, a reader saw a finished job with a truncated log. The worker listens for `close`, not `exit` — `exit` fires while the pipes are still draining.

The job log is capped at 32 MB; on overflow one `worker_log_truncated` line is appended and nothing after it is written, so a runaway Codex cannot fill the disk.

### Talking to a model

`codex exec resume <thread_id>` continues an earlier thread; the id comes from the `thread.started` event. Important: `exec resume` has no `--sandbox`, no `--cd`, and no `--ask-for-approval` — the sandbox mode is set through `-c sandbox_mode=...` and the working directory is the process's own. Model and reasoning effort must be passed on every turn: without them Codex silently falls back to the current defaults and the conversation drifts to a different model.

`chat-store.mjs` keeps the thread and its parameters. The lock is a directory (`mkdir` is atomic everywhere): two concurrent `resume` calls on one thread write into the same rollout and destroy the conversation. A missing thread is an explicit error — silently starting a new conversation would lose the whole prior exchange without warning.

### Background job manager

A state machine with no backward transitions:

```
running ──► done | failed | cancelled | timeout | unknown
```

Terminal states are immutable. This isn't decoration: `cancelJob()` used to write `cancelled`, and a later `child.on("exit")` would overwrite it with `done` — a cancelled job looked like a successful one.

The source of truth for completion is an **exit-code file**, not an event in the parent process. The worker writes it atomically (temp file + rename) after the log has flushed. This buys three things the `exit` handler never had: the exit code survives an MCP server restart, no descriptors leak (the parent spawns with `stdio: ignore` and detaches), and there is no race with cancellation.

Everything the worker needs travels in a `.spec` file — binary, arguments, paths, backend, timeout — rather than in a command string. Nothing is interpolated into a shell; there is no shell.

A process that vanishes without writing an exit code gets `unknown`, not `done`: treating the unknown as success is the worst available option.

### Is the job actually alive

A PID alone is not proof: numbers get reused, and after a reboot someone else's process answers to it — the job looked alive, and the safety-net `killTree` would have killed a stranger. The worker touches an `.alive` file every 5 s; a mark younger than 30 s means our process (with a 15 s startup grace). Jobs from older versions have no mark, so for them the old rule stands — PID plus age — otherwise every job that survived an update would go dead at once.

`liveJobs()` counts **processes, not statuses**. Cancellation marks a job terminal immediately while the worker is still running and still spending quota; trusting the status would let one `codex_cancel` bypass the parallel limit. `reconcile()` kills a leftover process only when `alive(pid)` confirms one is there.

### Parallel limit

`max_parallel_jobs` (4 by default, `0` removes it) is global, not per-repository: the ChatGPT quota, memory, and CPU are one resource shared across every project.

The check and the launch must be one operation, so `startJob()` runs under a directory lock (`mkdirSync` is atomic everywhere). A stale lock is removed by **renaming** it, not by `rmdir` + `mkdir`: delete-then-create is two operations, and between them another process takes the lock that the next `rmdir` then removes while it is live. Exactly one process succeeds at renaming an existing directory.

### Job retention

`sweepJobs()` runs from `listJobs()` at most once an hour and touches **terminal jobs only**: it deletes those finished more than 7 days ago and anything past the 200 most recent, across every extension a job owns (`json`, `out`, `prompt`, `spec`, `code`, `note`, `cancel`, `alive`). Without it the data directory grew without bound, and each `.out` is a full log of a Codex run.

### Job identifiers

`job_id` arrives from the model, so it goes through strict `/^job-[0-9a-f]{8}$/` validation plus a containment check after `path.resolve()`. The single place an identifier becomes a path is `jobPath()`. Without this, `../../outside-job` read files outside the jobs directory and let an arbitrary PID reach `kill`.

### Editing `config.toml`

The file belongs to the user, so every edit stays inside a marked block. Each of these subtleties was a bug:

- **Replace via a function.** `str.replace(re, block)` interprets `$&`, `$1`, `$'` in the replacement string: a plugin path containing `$&` injected the old block into the result. Only `replace(re, () => block)` is safe.
- **Escaping the markers.** `# >>> tandem (claude) >>>` contains parentheses — it goes into a `RegExp` only through `esc()`, otherwise the block is never found and a repeated `--link-back` piles up duplicates.
- **Global regex.** Several blocks could accumulate; `unlink()` removes all of them.
- **TOML string escaping.** A quote in the path broke the file. `tomlString()` escapes `\`, `"`, and control characters.
- **Conflicts.** If the user already has an unmanaged `[mcp_servers.claude-bridge]`, adding a second table would make the TOML invalid — the operation is refused and the file left untouched.
- **Atomicity.** Write to a temp file, then rename.

### Bridge path self-healing

`${CLAUDE_PLUGIN_ROOT}` changes on every plugin update, and the previous version's directory is removed after roughly 14 days. A path written once into `config.toml` would silently go stale after `/plugin update` and then break. `ensureFresh()` in the `SessionStart` hook compares the recorded path against the current one and rewrites it on mismatch.

### Tool restriction in `claude_task`

`--allowedTools` does **not** restrict the tool set — it only skips the confirmation prompt. `--tools` is what limits availability. This was a real bug: an administrative allowlist of `["Read"]` could be bypassed with a single argument from Codex.

`resolveTools()` intersects the requested set with the configured ceiling: narrowing is allowed, widening is not. An empty intersection isn't a reason to launch Claude with no tools — it's a refusal with an explanation. With `write: false`, write tools are stripped unconditionally and duplicated into `--disallowedTools`.

### MCP tool proxying

`tool-proxy.mjs` starts the allowed servers through `mcp-client.mjs`, reads their `tools/list`, and re-exports them as `<alias>__<tool>`. One server failing doesn't break the others.

Server discovery follows Claude Code precedence: **local → project → user**, first match wins. The order matters: previously the user-scope server was picked, overriding a developer's local setting.

Environment variables are stored in the allowlist **only as references** — `${VAR}` / `${VAR:-default}`. `sanitizeEnv()` drops literal values so other people's tokens never land in a plugin file. Expansion happens at server launch.

### Image generation

Without an explicit prohibition, Codex tends to write a Python or Node script against the paid Images API instead of using the built-in `image_gen`. The prompt in `buildPrompt()` closes that path with three separate statements, and `generateImage()` detects the slip from the output (`OPENAI_API_KEY`, `api.openai.com`, `images/generations`) and says so plainly.

A result is accepted only after these checks:

1. Codex's exit code — **before** looking for files, otherwise an unrelated artifact gets picked up;
2. `sniffImage()` — PNG/JPEG/GIF/WebP magic bytes, not the extension and not Codex's word for it;
3. `resolveInside()` — `out_dir` and references stay within the project root; absolute paths are refused;
4. `acceptableSource()` — a path from a `SAVED:` line is accepted only from inside the project or `$CODEX_HOME/generated_images/`.

The fallback scan of Codex's output directory filters by signature too.

### Model catalog

`codex debug models` → parsing that narrows the slice from both ends (the catalog is sometimes wrapped in notice text) → a 6-hour cache.

If the subcommand is unavailable, it degrades to `model` from `config.toml`, then to a stale cache. Such a catalog is flagged `complete: false`, and `knownModel()` **does not block** unknown models against it — otherwise perfectly valid names would be rejected.

### MCP transport

`mcp-lib.mjs` declares its supported versions explicitly (`2025-06-18`, `2025-03-26`) and echoes the requested one only when it supports it; otherwise it answers with its own. Malformed JSON yields `-32700 Parse error` rather than silence. Only the error message goes to the client — stack traces are written to stderr so paths and internals aren't exposed.

JSON-RPC batches are rejected deliberately: they were removed from MCP in revision 2025-06-18, which is what the server advertises.

The shape of an incoming message is checked before its fields are read. `null` and scalars are syntactically valid JSON, and destructuring one threw inside an async `line` handler that nobody catches — the whole server died, taking every in-flight call with it. Now it's `-32600`. A line larger than 16 MB is refused before `JSON.parse`, which would otherwise double the memory an oversized line costs.

`mcp-client.mjs` responds to a nested server's `exit`/`close` by failing all pending requests immediately and keeps the tail of its stderr — without this, a call after the server died hung for the full timeout and the cause was lost.

---

## Tests

```bash
node tests/regressions.mjs
```

119 tests, one per known defect. Real `codex` and `claude` binaries aren't needed: the suite creates its own stubs in a temp directory, driven by environment variables.

Covered: flag detection, terminal job states, exit code across restarts, descriptor leaks, `job_id` path traversal, tool allowlist bypass, forced read-only, an arbitrary file passed off as an image, path containment, `config.toml` corruption (`$&`, quotes, duplicates, conflicts), non-zero exit handling, file permissions and secret stripping, model catalog degradation, `setup` argument parsing, MCP precedence, version negotiation, parse errors, a scalar message not killing the server, the incoming line limit, stack trace leakage, reaction to a nested server dying, the parallel limit and its lock, heartbeat liveness against a reused PID, log truncation and Cyrillic split across a read boundary, secrets kept out of the diff, refusal without a merge base, the native review backend, and the fallback boundary that must not spend quota twice.

28 of them need POSIX — the stubs are shebang scripts, and `0600` permissions and quotes in filenames mean nothing on Windows. Those are reported as skipped, not as passed. The descriptor-leak test additionally needs `/proc` and is skipped outside Linux.

CI (`.github/workflows/tests.yml`) runs the suite on `ubuntu-latest` and `windows-latest` against Node 20.11 and 22, plus a separate `validate` job for `claude plugin validate . --strict`. The matrix exists because it caught real breakage: 28 tests that had never run on Windows were failing on Linux — English defaults compared against Russian substrings, a stub whose `process.exit` dropped buffered pipe output, and top-level `await` in `node -e`, which is parsed as CommonJS before Node 20.

Collaboration tests live in `tests/collaboration.mjs` (state, budgets, phases, recovery) and `tests/collaboration-bridges.mjs` (both MCP entry points with portable fake CLIs). The regression entry point runs both through Node's built-in test runner, so the existing CI matrix covers them without dependencies. Run only these tests with `node --test tests/collaboration.mjs tests/collaboration-bridges.mjs`.

### Collaboration protocol

`CollaborationSession` in `scripts/collaboration.mjs` owns the common lifecycle; `scripts/i18n-collaboration.mjs` owns English/Russian descriptors and prompts. The Codex adapter reuses job workers, publishing the job ID before waiting; polling never starts another job. The Claude adapter uses the existing cancellable process runner with Read/Grep/Glob only. No native thread resume or autonomous orchestration is added.

The state key hashes canonical cwd, backend, and validated session name. Atomic JSON snapshots live in the plugin data directory; the existing heartbeat lock serializes updates. A round is reserved before a model call; failure/cancellation still spends it. Each stage has six calls and monotonic mode-specific phases. Successful synthesis closes it; explicit extension requires a summary and caller attestation. Full transcripts remain local; prompts include only the summary, current stage, and explicitly bounded reply excerpts. The local state path is never sent to the second model.

State schema is version 2. Version 1 files are upgraded in memory on read and persisted as version 2 on the next locked write; reading alone never rewrites the file. An older plugin cannot read version 2 files.

`compare` mode stores the host's `commitment` per stage with its SHA-256. It is accepted once, with the first `solve` turn and before any call of that stage, and enters the prompt as `host_commitment` only from the `compare` phase on. A `solve` message containing the commitment verbatim is rejected; paraphrases cannot be detected.

Token accounting: each finished round stores `usage` (`tokens`, `estimated`), and the session total must equal their sum. Codex usage is `input_tokens − cached_input_tokens + output_tokens` from `turn.completed`; Claude collaboration runs with `--output-format json` and counts `input_tokens + output_tokens`, excluding cache reads and writes, which repeat on every internal agent step. Missing usage (old CLI, failure, cancellation) is estimated as `ceil(chars / 3)` of prompt and reply. `max_tokens` is soft: checked before a turn under the lock.

`collaboration-codex.mjs` enumerates configured MCP servers and disables them individually: `mcp_servers={}` would merge rather than clear inherited tables. It also disables hooks, plugins, apps, and multi-agent features and rejects sandbox bypass. Worker environments carry a recursion guard, and both bridges reject nested calls. These controls do not redact secrets or authenticate a human's continuation request.

---

## Publishing

The repository is simultaneously the plugin and a single-plugin marketplace: `.claude-plugin/marketplace.json` sits at the root and its only entry points at `"source": "."` — the root itself.

```bash
claude plugin validate . --strict
```

This checks the manifest, command and agent frontmatter, and `hooks.json`. `--strict` turns warnings into errors, which is useful in CI.

### Versioning

`plugin.json` sets `"version"`. While that field is present, users receive updates **only after you bump it**: new commits aren't enough, Claude Code sees the same version string and keeps the cached copy.

During active development you can drop the field — the commit SHA then becomes the version and updates ship with every push.

`plugin.json` is the single source of the version: `version.mjs` reads it, and both MCP servers pass the result into `serve({ version })`. Nothing else needs editing on a bump.

### Multiple plugins in one repository

If other plugins appear, move this one to `plugins/tandem/` and change `source` to `"./plugins/tandem"`. Entry paths resolve relative to the directory containing `.claude-plugin/`.

---

## Debugging

```bash
claude --plugin-dir /path/to/tandem   # run without installing
claude --debug                              # plugin loading, MCP init
/tandem:setup                                # environment diagnostics
```

You can talk to an MCP server directly:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | node scripts/mcp-codex.mjs
```

The reverse bridge works the same way via `node bridge/mcp-claude.mjs`; it reads its allowlist from `TANDEM_EXPOSED` (default `~/.codex/tandem/exposed.json`).

Useful environment variables for tests and debugging: `CODEX_BIN`, `CLAUDE_BIN`, `CLAUDE_PLUGIN_DATA`, `TANDEM_CONFIG`, `TANDEM_EXPOSED`, `CODEX_HOME`.

Every plugin setting also arrives as an environment variable, which is how the tests drive them: `TANDEM_LANG`, `TANDEM_MODEL`, `TANDEM_EFFORT`, `TANDEM_REASONING_SUMMARY`, `TANDEM_REVIEW_BACKEND`, `TANDEM_PROGRESS`, `TANDEM_MAX_PARALLEL_JOBS`, `TANDEM_JOB_TIMEOUT_MIN`, `TANDEM_IMAGE_DIR`, `TANDEM_IMAGE_TIMEOUT_MIN`, `TANDEM_BYPASS_SANDBOX`.

---

## Unverified assumptions

An honest list of what has never been checked against live binaries:

1. **The `aspect_ratio` / `image_resolution` constraints** (`auto` only with `1K`, `1:1` without `4K`) come from a third-party API's documentation and are unconfirmed for the built-in `image_gen`. They may reject valid parameters — two lines in `validate()` in `image-core.mjs` remove them.
2. **The output format of `codex debug models`** is parsed leniently (`parseCatalog()`), but has never been tested against real output.
3. **The exact `codex exec` flag set** is detected from `--help`; parsing help text with regexes is itself an assumption.
4. **The behaviour of `claude -p --tools`** was verified from documentation, not against a real binary.

The `codex app-server` protocol is no longer on this list: the method names, the optional `jsonrpc` field, the item shape, and the `thread/tokenUsage/updated` counters were all checked against a live binary.

A first run in a real environment should proceed in order of increasing risk: `/tandem:setup` → `/tandem:models` → `/tandem:review` → `/tandem:delegate` → `/tandem:image`.

## Contributing

Patches are accepted with a test for the behaviour being fixed. Changes touching security (tool allowlists, path containment, file permissions, `config.toml` editing) must come with a test that fails without the fix.
