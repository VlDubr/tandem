---
description: Solve a task independently alongside GPT, then compare both answers and reach a verdict
argument-hint: "[--session <name>] [--max-tokens N] [--continue] <task>"
allowed-tools: mcp__plugin_tandem_codex__codex_collaborate, mcp__plugin_tandem_codex__codex_progress
---

Solve this task independently of GPT, then compare the two answers: `$ARGUMENTS`.

The value of this mode is independence. Your answer must exist before GPT's answer is visible to you, and GPT must not see yours while solving.

1. **Commit your answer first.** Solve the task yourself completely, with your own tools. Write the finished answer, its assumptions, and how it can be verified. Do not call GPT before this answer is ready.
2. **Independent solve.** Call `codex_collaborate` with `mode: "compare"`, `phase: "solve"`, a short session name (or `--session`), and your answer in `commitment`. In `message`, state only the task, constraints, and expected output format. Never paraphrase or hint at your own answer there: the server rejects a message that contains the commitment verbatim, but a paraphrase still destroys independence. The commitment is stored locally and accepted only once per stage; you cannot revise it after seeing GPT's answer.
3. **Comparison.** Call `phase: "compare"`. The server now reveals your commitment to GPT as `host_commitment`. Ask for a structured comparison on correctness, completeness, risks, and verifiability, naming concrete errors in each answer. Check GPT's claims yourself, and run tests or checks wherever possible instead of trusting either model.
4. **Verdict.** Call `phase: "synthesize"` for the joint verdict. Report which answer wins on each criterion, errors found in each, what was verified versus assumed, and the recommended final answer. If one answer is clearly wrong, say so; do not average two answers into a compromise.

If `--max-tokens N` is given, pass `max_tokens: N` on the first turn. The budget is soft: it is checked before each turn, so the last turn may exceed it, and unreported usage is estimated (`tokens.estimated`). When it is exhausted, ask the user; continue only through `action: "extend"` with `confirm: true`, a `summary`, and a larger `max_tokens`. The same applies to the six-call stage limit. A new stage requires a new commitment.

For `pending`, poll `action: "status"` with `wait_seconds` or `codex_progress`; never submit a replacement turn. `action: "cancel"` cancels the outstanding round. `action: "list"` shows this workspace's sessions; `action: "forget", confirm: true` deletes a session's local transcript after the user agrees.

The session is read-only. If the winning answer requires file changes, present it and ask permission before using a write-capable delegation tool. Never include credentials or sensitive files.
