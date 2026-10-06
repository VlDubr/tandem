---
description: Research a topic jointly with GPT through a persistent, multi-round dialogue
argument-hint: "[--session <name>] [--max-tokens N] [--continue] <topic or new contribution>"
allowed-tools: mcp__plugin_tandem_codex__codex_collaborate, mcp__plugin_tandem_codex__codex_progress
---

Research this topic together with GPT: `$ARGUMENTS`.

You are the coordinator and an active researcher, not a relay. Choose a short session name unless the user supplies `--session`. Use `codex_collaborate` with `mode: "research"`. Keep using the same session. Start with `action: "status"` when continuing an existing session.

1. Clarify the objective and constraints. Form your own initial hypotheses, then call `phase: "explore"`. Put the question, your contribution, and a bounded read-only investigation in `message`; use `context` only on the first turn.
2. Check GPT's evidence, investigate independently with your own available tools, and send a substantive next contribution. Assign complementary investigations rather than repeating the same search. Distinguish facts, hypotheses, and unresolved questions. Neither agreement nor a confident answer proves correctness.
3. When evidence is sufficient, call `phase: "synthesize"` with your proposed solution and request a joint assessment. Reserve the sixth call for synthesis where possible. Report the solution, evidence, rejected alternatives, disagreements, and verification still needed. Stop early when further exchange adds no value.

Each stage permits at most six second-model calls, including failed or cancelled attempts. Do not automatically extend a stage. The user must explicitly request continuation (`--continue` counts); then call `action: "extend", confirm: true` with a concise `summary` of findings, constraints, disagreements, and open questions before the next turn. This attestation is a coordinator rule, not server-side authentication of the user. An extension preserves the local transcript but supplies only the summary and the new stage to GPT.

If a response is `pending`, use `action: "status"` with `wait_seconds` or `codex_progress`; never start a replacement call. `action: "cancel"` cancels the outstanding round. Show meaningful intermediate contributions labelled by model, not hidden reasoning or an undifferentiated wall of transcript. Explicitly identify truncated replies; the complete reply remains in `state_file`.

The dialogue is read-only. Do not delegate back recursively. Never include credentials or sensitive files in prompts. If implementation is needed, present it separately and obtain permission before using a write-capable delegation tool. Do not claim web research when the available tools only inspected local files.

If `--max-tokens N` is given, pass `max_tokens: N` on the first turn. The token budget is soft: checked before each turn, so the last turn may exceed it; unreported usage is estimated (`tokens.estimated` in the response). When it is exhausted, ask the user and continue only through `action: "extend"` with `confirm: true`, a `summary`, and a larger `max_tokens`. `action: "list"` shows this workspace's sessions; `action: "forget", confirm: true` deletes a session's local transcript, only after the user agrees.
