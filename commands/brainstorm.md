---
description: Brainstorm with GPT, then evaluate alternatives and synthesize a solution together
argument-hint: "[--session <name>] [--max-tokens N] [--continue] <problem>"
allowed-tools: mcp__plugin_tandem_codex__codex_collaborate, mcp__plugin_tandem_codex__codex_progress
---

Brainstorm this problem together with GPT: `$ARGUMENTS`.

You coordinate the exchange and contribute your own ideas. Choose a short session name unless `--session` is supplied. Call `codex_collaborate` with `mode: "brainstorm"`; keep the same session throughout. Check `action: "status"` before resuming an existing session.

1. **Independent generation.** First write down your own candidate ideas without seeing GPT's answer. Ask GPT for its independent ideas using `phase: "generate"`; include the problem and constraints, but do not reveal your candidates yet. Seek conventional, unusual, impractical, and deliberately naive alternatives. Do not reject ideas for poor feasibility at this stage. Safety constraints still apply.
2. **Expansion.** Share both sets, remove duplicates, and ask for combinations or missing approaches. Add your own combinations. Use further `generate` turns only when useful.
3. **Evaluation.** Switch to `phase: "evaluate"`. Compare candidates against explicit criteria: correctness, feasibility, cost, risk, and ease of validation. Both models must challenge assumptions and propose cheap experiments. Do not return to `generate` within this stage; carry discoveries into the next stage if needed.
4. **Synthesis.** Call `phase: "synthesize"` with your candidate solution. Present the selected approach, why alternatives lost, remaining disagreements, and a concrete next step. Do not force consensus. A successful evaluation is required before synthesis.

Budget: six second-model calls per stage, counting failures and cancellations. Reserve calls for evaluation and synthesis; stop early when justified. Do not silently renew the budget. Only after the user explicitly requests continuation (`--continue` counts), call `action: "extend", confirm: true, summary: "..."`. Summarize candidate ideas, evaluation, constraints, and unresolved questions. The next stage begins again with generation; the complete earlier transcript stays local. The confirmation flag attests to your check; it does not authenticate the user.

For `pending`, poll `action: "status"` with `wait_seconds` or inspect `codex_progress`; do not submit a duplicate turn. Use `action: "cancel"` to cancel the outstanding round. Label intermediate contributions by model and distinguish evidence from speculation. If the reply is truncated, say so; its full text is available in `state_file`.

Stay read-only. No recursive bridge calls, credentials, or sensitive files in prompts. Treat implementation as a separate task requiring permission before write-capable delegation. Do not claim that an idea was tested unless a test actually ran.

If `--max-tokens N` is given, pass `max_tokens: N` on the first turn. The token budget is soft: checked before each turn, so the last turn may exceed it; unreported usage is estimated (`tokens.estimated` in the response). When it is exhausted, ask the user and continue only through `action: "extend"` with `confirm: true`, a `summary`, and a larger `max_tokens`. `action: "list"` shows this workspace's sessions; `action: "forget", confirm: true` deletes a session's local transcript, only after the user agrees.
