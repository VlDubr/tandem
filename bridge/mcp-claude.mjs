#!/usr/bin/env node
// MCP stdio-сервер для направления GPT → Claude. Регистрируется в
// ~/.codex/config.toml командой /tandem:setup --link-back.
//
// Даёт Codex три класса инструментов:
//   1. claude_ask / claude_critique — Claude как консультант (только чтение)
//   2. claude_task                  — делегирование Claude задачи с его инструментами
//   3. <server>__<tool>             — инструменты MCP-серверов Claude напрямую
//
// Пункты 2 и 3 выключены по умолчанию и включаются через /tandem:setup.

import { spawn } from "node:child_process";
import { serve, text, fail } from "../scripts/mcp-lib.mjs";
import { pluginVersion } from "../scripts/version.mjs";
import { killTree, isWindows } from "../scripts/proc.mjs";
import { ToolProxy, readExposed } from "./tool-proxy.mjs";
import { toolText, prompt as claudePrompt, message } from "./i18n-claude.mjs";
import { CollaborationSession, collaborationTool } from "../scripts/collaboration.mjs";
import { collaborationMessage } from "../scripts/i18n-collaboration.mjs";

const cleanEnv = (n) => {
  const v = process.env[n];
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return !t || /^\$\{.*\}$/.test(t) ? undefined : t;
};
const CLAUDE_BIN = cleanEnv("CLAUDE_BIN") || "claude";
const cfg = readExposed();

// ------------------------------------------------------- Claude как процесс

// Инструменты, дающие запись. При write:false вырезаются жёстко, вне
// зависимости от того, что запросила вызывающая сторона.
const WRITE_TOOLS = ["Edit", "Write", "NotebookEdit", "Bash", "MultiEdit"];

// Предел на вывод одного вызова. Считается в байтах, а не в символах строки:
// сравнивать длину JS-строки с «мегабайтами» неверно, кириллица и эмодзи дают
// в UTF-8 больше байт, чем символов.
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/** Живые процессы Claude: при остановке моста их нельзя оставлять сиротами. */
const running = new Set();

function stopAll() {
  for (const child of running) killTree(child.pid);
}

/**
 * ВАЖНО: --allowedTools НЕ ограничивает набор инструментов, он лишь снимает
 * запрос подтверждения. Ограничение доступности даёт --tools, а --disallowedTools
 * блокирует поимённо. Используем --tools как основной механизм и
 * --disallowedTools как страховку для write-инструментов.
 *
 * Запуск асинхронный. Прежний spawnSync блокировал event loop на всё время
 * работы Claude — до десяти минут: сервер не отвечал на ping, не принимал
 * отмену и сериализовал все параллельные вызовы. Ровно этот дефект уже был
 * исправлен на стороне Codex, а на обратном направлении оставался.
 */
function runClaude(prompt, { model, tools, denyTools, mode = "plan", timeoutMs = 600_000, signal, cwd, collaboration = false } = {}) {
  const args = ["-p", "--model", model || "sonnet", "--permission-mode", mode];
  if (collaboration) {
    // JSON-вывод нужен ради usage: без него бюджет токенов держался бы на оценке.
    args.push("--output-format", "json");
    args.push("--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}');
    args.push("--settings", '{"disableAllHooks":true}');
  }
  if (Array.isArray(tools)) args.push("--tools", tools.join(","));
  if (denyTools?.length) args.push("--disallowedTools", denyTools.join(","));

  return new Promise((resolve) => {
    if (signal?.aborted)
      return resolve({ ok: false, aborted: true, error: message("cancelled_before_start") });

    let child;
    try {
      child = spawn(CLAUDE_BIN, args, {
        stdio: ["pipe", "pipe", "pipe"],
        cwd,
        env: collaboration ? { ...process.env, TANDEM_COLLABORATION_CHILD: "1" } : process.env,
        // Своя группа процессов: Claude запускает подпроцессы, и убийство
        // одного лидера оставило бы их работать. На Windows группу заменяет
        // taskkill /T внутри killTree.
        detached: !isWindows,
        windowsHide: true,
      });
    } catch (e) {
      return resolve({ ok: false, error: String(e?.message || e) });
    }
    running.add(child);

    const outChunks = [];
    const errChunks = [];
    let outputBytes = 0;
    let settled = false;
    let timer = null;

    // Исход один, кто бы ни пришёл первым: выход, ошибка, таймаут, отмена или
    // переполнение. Без единой точки разрешения гонки промис резолвился бы
    // дважды, а таймер и слушатель отмены оставались бы висеть.
    const settle = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      timer = null;
      signal?.removeEventListener?.("abort", onAbort);
      child.stdout?.off("data", onStdout);
      child.stderr?.off("data", onStderr);
      child.stdout?.resume();
      child.stderr?.resume();
      resolve(result);
    };

    function onAbort() {
      killTree(child.pid);
      settle({ ok: false, aborted: true, error: message("cancelled") });
    }
    signal?.addEventListener?.("abort", onAbort, { once: true });

    const overflow = () => {
      killTree(child.pid);
      settle({
        ok: false,
        error: message("combined_output_overflow", Math.round(MAX_OUTPUT_BYTES / 1024 / 1024)),
      });
    };

    function onStdout(b) {
      if (settled) return;
      outputBytes += b.length;
      if (outputBytes > MAX_OUTPUT_BYTES) return overflow();
      outChunks.push(b);
    }
    function onStderr(b) {
      if (settled) return;
      outputBytes += b.length;
      if (outputBytes > MAX_OUTPUT_BYTES) return overflow();
      errChunks.push(b);
    }
    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);

    // В running процесс остаётся до фактического закрытия, даже если вызов уже
    // завершён таймаутом или отменой, а SIGTERM ещё не успел подействовать.
    child.once("close", () => running.delete(child));

    child.on("error", (e) => {
      settle(
        e?.code === "ENOENT"
          ? { ok: false, error: message("claude_not_found") }
          : { ok: false, error: String(e?.message || e) }
      );
    });

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        killTree(child.pid);
        settle({ ok: false, error: message("timeout") });
      }, timeoutMs);
    }

    child.stdin.on("error", () => {}); // закрытый stdin не должен ронять мост
    child.stdin.write(prompt);
    child.stdin.end();

    // close, а не exit: к этому моменту потоки дочитаны до конца.
    child.on("close", (code, sig) => {
      const out = Buffer.concat(outChunks).toString("utf8").trim();
      const errText = Buffer.concat(errChunks).toString("utf8").trim();

      // Ненулевой код — ошибка даже при непустом stdout: частичный отчёт,
      // выданный за успешный результат, опаснее явного отказа.
      if (code !== 0) {
        return settle({
          ok: false,
          error:
            message("exit", code, sig) +
            (errText ? `\n${errText.slice(0, 800)}` : "") +
            (out ? `\n\n${message("partial_output", out.slice(0, 800))}` : ""),
        });
      }
      if (!out) return settle({ ok: false, error: errText || message("empty_response") });
      settle({ ok: true, output: out });
    });
  });
}

/**
 * Пересечение запрошенного набора с административным allowlist.
 * Codex сам передаёт allowed_tools, поэтому расширять список ему нельзя —
 * иначе настройка task_tools: ["Read"] обходится одним аргументом.
 */
function resolveTools(requested, configured, write) {
  const admin = Array.isArray(configured)
    ? configured.filter((tool) => typeof tool === "string" && tool.trim()).map((tool) => tool.trim())
    : null;
  const asked = Array.isArray(requested)
    ? requested.filter((tool) => typeof tool === "string" && tool.trim()).map((tool) => tool.trim())
    : null;

  // Режим acceptEdits безопасен только при явном административном потолке.
  // Отсутствующий и пустой task_tools — deny-all, а не разрешение всех tools.
  if (write && !admin?.length) {
    return { error: message("task_write_allowlist_required") };
  }

  let tools = admin?.length ? admin : null;
  if (asked?.length) {
    tools = admin ? admin.filter((t) => asked.includes(t)) : [...asked];
    if (admin && !tools.length) {
      // Пустое пересечение — не повод молча запустить Claude без инструментов:
      // это запрос за пределы allowlist, и об этом надо сказать.
      return {
        error: message("tools_not_allowed", asked, admin),
      };
    }
  }

  if (!write) {
    const deny = new Set(WRITE_TOOLS);
    const before = tools;
    tools = (tools || ["Read", "Grep", "Glob"]).filter((t) => !deny.has(t.split("(")[0]));
    if (!tools.length) {
      return {
        error: message("no_tools_after_write_filter", WRITE_TOOLS, before),
      };
    }
  }
  return { tools };
}

// ------------------------------------------------------------- свои инструменты

const tx = toolText();

const OWN_TOOLS = [
  collaborationTool("claude"),
  {
    name: "claude_ask",
    description: tx.ask_d,
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: tx.ask_question },
        context: { type: "string", description: tx.ask_context },
        model: { type: "string", description: tx.ask_model },
      },
      required: ["question"],
    },
  },
  {
    name: "claude_critique",
    description: tx.critique_d,
    inputSchema: {
      type: "object",
      properties: {
        proposal: { type: "string", description: tx.critique_proposal },
        model: { type: "string", description: tx.critique_model },
      },
      required: ["proposal"],
    },
  },
];

const TASK_TOOL = {
  name: "claude_task",
  description: tx.task_d,
  inputSchema: {
    type: "object",
    properties: {
      task: {
        type: "string",
        description: tx.task_task,
      },
      allowed_tools: {
        type: "array",
        items: { type: "string" },
        description: tx.task_allowed_tools,
      },
      write: {
        type: "boolean",
        default: false,
        description: tx.task_write,
      },
      model: { type: "string", description: tx.task_model },
    },
    required: ["task"],
  },
};

// ------------------------------------------------------------------- сборка

const proxy = new ToolProxy();
if (process.env.TANDEM_COLLABORATION_CHILD !== "1" && Object.keys(cfg.servers).length) await proxy.start();

const TOOLS = [...OWN_TOOLS, ...(cfg.allowTask ? [TASK_TOOL] : []), ...proxy.toolDescriptors()];

if (proxy.errors.length) {
  process.stderr.write(message("proxy_errors", proxy.errors));
}

// ------------------------------------------------------------------ обработка

/**
 * Ответ claude -p --output-format json: текст в result, расход в usage.
 * Кешированный ввод не входит в бюджет: он повторно считается на каждом
 * внутреннем шаге агента и сделал бы лимит бессмысленным.
 */
export function claudeCollaborationResult(r) {
  if (!r.ok) return r;
  let data;
  try {
    data = JSON.parse(r.output);
  } catch {
    return r; // старый CLI без JSON: текст как есть, расход оценивается
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return r;
  // Ошибка Claude Code (error_max_turns, error_during_execution) приходит без
  // поля result и с кодом 0: её нельзя принять за успешный ход.
  if (data.is_error === true) {
    return { ok: false, error: (typeof data.result === "string" && data.result) || data.subtype || message("empty_response") };
  }
  if (typeof data.result !== "string") {
    return data.type === "result" ? { ok: false, error: data.subtype || message("empty_response") } : r;
  }
  if (!data.result.trim()) return { ok: false, error: message("empty_response") };
  // input_tokens не включает кеш; запись в кеш — это и есть основной промпт
  // claude -p, поэтому она входит в бюджет. Повторно читаемый кеш — нет.
  const u = data.usage;
  const creation = Number.isSafeInteger(u?.cache_creation_input_tokens) ? u.cache_creation_input_tokens : 0;
  const usage = u && Number.isSafeInteger(u.input_tokens) && Number.isSafeInteger(u.output_tokens)
    ? { input: u.input_tokens + creation, output: u.output_tokens }
    : undefined;
  return usage ? { ok: true, output: data.result, usage } : { ok: true, output: data.result };
}

async function dispatch(name, args, ctx = {}) {
  if (process.env.TANDEM_COLLABORATION_CHILD === "1") return fail(collaborationMessage("nested"));
  if (name === "claude_collaborate") {
    const cwd = cleanEnv("TANDEM_CWD") || cleanEnv("CLAUDE_PROJECT_DIR") || process.cwd();
    const runner = {
      start: async (prompt, options, context) => claudeCollaborationResult(await runClaude(prompt, {
        model: options.model,
        cwd,
        tools: ["Read", "Grep", "Glob"],
        denyTools: WRITE_TOOLS,
        signal: context.signal,
        collaboration: true,
      })),
    };
    try {
      const session = new CollaborationSession({ backend: "claude", cwd, runner, defaults: { model: "sonnet" } });
      return text(JSON.stringify(await session.handle(args, ctx), null, 2));
    } catch (error) {
      return fail(error.message || String(error));
    }
  }
  if (proxy.has(name)) {
    try {
      const res = await proxy.call(name, args);
      if (res && Array.isArray(res.content)) return res; // уже формат MCP
      return text(JSON.stringify(res));
    } catch (e) {
      return fail(message("proxied_tool_failed", name, e.message || e));
    }
  }

  if (name === "claude_ask") {
    const r = await runClaude(claudePrompt("ask", args.question, args.context), {
      model: args.model,
      signal: ctx.signal,
    });
    return r.ok ? text(message("answer", r.output)) : fail(r.error);
  }

  if (name === "claude_critique") {
    const r = await runClaude(claudePrompt("critique", args.proposal), {
      model: args.model,
      signal: ctx.signal,
    });
    return r.ok ? text(message("answer", r.output)) : fail(r.error);
  }

  if (name === "claude_task") {
    if (!cfg.allowTask) return fail(message("task_disabled"));
    const write = args.write === true;
    const resolved = resolveTools(args.allowed_tools, cfg.taskTools, write);
    if (resolved.error) return fail(resolved.error);
    const tools = resolved.tools;
    const denyTools = write ? [] : WRITE_TOOLS;
    const r = await runClaude(claudePrompt("task", args.task, write), {
      model: args.model,
      tools,
      denyTools,
      mode: write ? "acceptEdits" : "plan",
      signal: ctx.signal,
    });
    return r.ok ? text(message("report", r.output)) : fail(r.error);
  }

  return fail(message("unknown_tool", name));
}

let accepting = true;
const activeCalls = new Set();

async function handle(name, args, ctx = {}) {
  if (!accepting) return fail(message("bridge_closing"));
  const call = dispatch(name, args, ctx);
  activeCalls.add(call);
  try {
    return await call;
  } finally {
    activeCalls.delete(call);
  }
}

// Мост уходит — Claude уходит с ним. Иначе закрытие Codex оставляет позади
// процессы, которые продолжают править файлы в репозитории без надзора.
// Закрытие stdin намеренно НЕ убивает Claude: клиент закрывает поток сразу
// после отправки запроса, и убийство по этому событию отменяло бы работу,
// которую сам же клиент и заказал. Сервер доживает до конца вызова и уходит
// по exit — тогда и снимаются процессы.
process.on("exit", () => {
  stopAll();
  proxy.stop();
});
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    stopAll();
    proxy.stop();
    process.exit(130);
  });
}

process.stdin.once("end", async () => {
  accepting = false;
  // EOF означает, что новых запросов уже не будет, но текущий заказ клиента
  // обязан завершиться. Только после него можно остановить дочерние MCP-серверы.
  await Promise.allSettled([...activeCalls]);
  proxy.stop();
  process.exit(0);
});

serve({ name: "claude-bridge", version: pluginVersion(), tools: TOOLS, handle });
