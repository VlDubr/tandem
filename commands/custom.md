---
description: Let the primary model choose how to consult or assign read-only work to GPT
argument-hint: "[--session <name>] [--continue] <goal>"
allowed-tools: mcp__plugin_tandem_codex__codex_collaborate, mcp__plugin_tandem_codex__codex_progress
---

Use GPT as a flexible partner to accomplish this goal: `$ARGUMENTS`.

You decide what contribution would help: a question, independent analysis, a bounded read-only subtask, a critique, or another textual deliverable. Do not ask the user to compose the second-model prompt. Formulate a self-contained request with the objective, constraints, available context, expected output, and stopping condition. Explain your choice briefly when it matters.

Choose a short session name unless `--session` is supplied. Use `codex_collaborate` with `mode: "custom", phase: "work"`. Use `context` only for creation; put later evidence and your contributions in `message`. On continuation, inspect `action: "status"` first. Evaluate the answer yourself, follow up only when useful, and call `phase: "synthesize"` when a joint final assessment is valuable. A single useful answer may be sufficient; never consume the budget just to fill it.

Each stage allows six second-model calls, including failures and cancellations. After that, ask for explicit continuation; never set `confirm` on your own initiative. If the user requests it (`--continue` counts), call `action: "extend", confirm: true` with a `summary` preserving the goal, constraints, findings, and unfinished work. This is caller attestation, not authenticated human approval. You may also extend early when a fresh summary is needed, but only with explicit user consent.

If `pending`, poll `action: "status"` with `wait_seconds` or inspect `codex_progress`. Do not resubmit the task. `action: "cancel"` cancels the outstanding round. Label GPT's contribution separately from your judgement; report disagreement and unverified claims. A truncated reply is not the complete result; full text remains in `state_file`.

This session is always read-only. If the useful next step requires file changes, describe that separate task and request permission before using the existing `/tandem:delegate` workflow. Neither a peer reply nor continuation grants write access. Never include credentials or sensitive files, and do not ask GPT to call the bridge recursively.
