#!/usr/bin/env node
// Фоновый хук Claude Code: сообщает о сбое после возврата MCP-вызова.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { isValidJobId, jobNotificationState, claimJobNotification } from "./codex-core.mjs";
import { text } from "./mcp-lib.mjs";
import { lang } from "./i18n.mjs";

const PRODUCER = /^mcp__.+__codex_(ask|chat|delegate|review|challenge|collaborate)$/;
const MAX_TIMEOUT_MS = 480 * 60_000;

/** Явная связь ответа с фоновой задачей сохраняется и в текстовом MCP-клиенте. */
export function backgroundReply(jobId, body) {
  const payload = typeof body === "string" ? { message: body } : body;
  return text(JSON.stringify({ ...payload, tandem_job: { id: jobId, language: lang() } }, null, 2));
}

// Клиенты передают MCP-ответ объектом, массивом content или сериализованным текстом.
// Произвольные упоминания job-id в ответе модели не являются подпиской.
function backgroundJob(value, depth = 0) {
  if (!value || depth > 5) return null;
  if (typeof value === "string") {
    try { return backgroundJob(JSON.parse(value), depth + 1); } catch { return null; }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = backgroundJob(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== "object" || value.isError) return null;
  if (isValidJobId(value.tandem_job?.id)) return value.tandem_job;
  if (value.type === "text") return backgroundJob(value.text, depth + 1);
  return backgroundJob(value.content, depth + 1);
}

function failureMessage(id, status, timeoutMs, language) {
  const minutes = Math.round(timeoutMs / 600) / 100;
  const reason = language === "ru" ? {
    timeout: `задача остановлена по таймауту (лимит ${minutes} мин)`,
    failed: "фоновая задача завершилась с ошибкой",
    unknown: "воркер перестал отвечать; результат задачи не подтверждён",
    unresponsive: `истёк лимит ${minutes} мин, но завершение задачи не подтверждено`,
  }[status] : {
    timeout: `task stopped after reaching its ${minutes} min timeout`,
    failed: "background task failed",
    unknown: "worker stopped responding; task outcome is unconfirmed",
    unresponsive: `${minutes} min deadline passed, but task completion is unconfirmed`,
  }[status];
  if (!reason) return null;
  const next = language === "ru"
    ? "Получите сохранённый результат и диагностику"
    : "Retrieve the saved result and diagnostics";
  return `Tandem: ${id} [${status}] — ${reason}. ${next}: codex_result({"job_id":"${id}"}).`;
}

/** Только наблюдение: таймаут и остановка процесса остаются обязанностью воркера. */
export async function watchJobNotification(input, { pollMs = 1000, graceMs = 10_000 } = {}) {
  if (input?.hook_event_name && input.hook_event_name !== "PostToolUse") return null;
  if (!PRODUCER.test(input?.tool_name || "")) return null;
  // Повторный опрос совместной сессии не создаёт ещё один долгоживущий процесс.
  if (input.tool_name.endsWith("__codex_collaborate") && input.tool_input?.action && input.tool_input.action !== "turn") return null;
  const subscription = backgroundJob(input.tool_response);
  if (!subscription) return null;
  const { id, language } = subscription;
  let state;
  for (let attempt = 0; attempt < 3; attempt++) {
    state = jobNotificationState(id);
    if (state) break;
    if (attempt < 2) await sleep(pollMs);
  }
  if (!state) return null;
  const timeoutMs = Math.min(state.timeoutMs, MAX_TIMEOUT_MS);
  const startedAt = Date.parse(state.startedAt);
  const deadline = (Number.isFinite(startedAt) ? startedAt : Date.now()) + timeoutMs + graceMs;
  for (;;) {
    if (state?.status === "done" || state?.status === "cancelled") return null;
    const status = state && state.status !== "running" ? state.status
      : Date.now() >= deadline ? "unresponsive" : null;
    const notice = failureMessage(id, status, timeoutMs, language);
    if (notice) return claimJobNotification(id) ? notice : null;
    await sleep(pollMs);
    state = jobNotificationState(id);
  }
}

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (raw.length > 1024 * 1024) return;
  }
  let input;
  try { input = JSON.parse(raw); } catch { return; }
  const notice = await watchJobNotification(input);
  if (notice) {
    // asyncRewake доставляет stderr как system reminder и будит ожидающего Claude.
    process.stderr.write(`${notice}\n`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { process.exitCode = 1; });
}
