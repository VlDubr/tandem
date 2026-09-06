#!/usr/bin/env node
// MCP stdio-сервер: даёт Claude инструменты для обращения к Codex/GPT.
// Транспорт — общий mcp-lib.mjs, без внешних зависимостей.

import { serve, text, fail as err } from "./mcp-lib.mjs";
import { pluginVersion } from "./version.mjs";
import {
  probeCodex,
  runJob,
  startJob,
  followJob,
  listJobs,
  resolveJob,
  jobOutput,
  jobProgress,
  jobTrail,
  jobAnswer,
  jobThreadId,
  jobResult,
  cancelJob,
  humanAge,
  envClean,
  reviewBackend,
  repoKey,
  buildPrompt,
} from "./codex-core.mjs";
import { appServerReviewTarget } from "./app-server.mjs";
import { normalize, askedLine } from "./codex-events.mjs";
import { fetchModels, formatModels, knownModel, validateEffort, effortLevels } from "./models.mjs";
import { readChat, writeChat, listChats, deleteChat, withChatLock, isValidSlug } from "./chat-store.mjs";
import { readPrefs, writePrefs } from "./prefs.mjs";
import { toolText, uiText } from "./i18n.mjs";

const T = toolText();
// Ответы берутся на каждый вызов: язык задаётся окружением процесса.
const U = uiText;
const EFFORT_DESC = T.effort;
// Набор уровней берётся из каталога Codex, а не только из зашитой основы:
// иначе новый уровень (ultra) не доходит до вызывающего. Схема строится один
// раз при старте, поэтому набор читается из кэша, без запуска codex.
const EFFORT_SET = effortLevels();

const TOOLS = [
  {
    name: "codex_ask",
    description: T.ask_d,
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: T.ask_question },
        context: { type: "string", description: T.ask_context },
        model: { type: "string", description: T.ask_model },
        wait_seconds: { type: "number", default: 90, description: T.ask_wait },
        effort: { type: "string", enum: EFFORT_SET, description: EFFORT_DESC },
      },
      required: ["question"],
    },
  },
  {
    name: "codex_chat",
    description: T.chat_d,
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: T.chat_message },
        chat: { type: "string", description: T.chat_chat },
        model: { type: "string", description: T.chat_model },
        effort: { type: "string", enum: EFFORT_SET, description: EFFORT_DESC },
        context: { type: "string", description: T.chat_context },
        write: { type: "boolean", default: false, description: T.chat_write },
        wait_seconds: { type: "number", default: 120, description: T.chat_wait },
      },
      required: ["message"],
    },
  },
  {
    name: "codex_chats",
    description: T.chats_d,
    inputSchema: {
      type: "object",
      properties: {
        forget: { type: "string", description: T.chats_forget },
      },
    },
  },
  {
    name: "codex_use",
    description: T.use_d,
    inputSchema: {
      type: "object",
      properties: {
        model: { type: "string", description: T.use_model },
        effort: { type: "string", enum: EFFORT_SET, description: EFFORT_DESC },
        clear: { type: "boolean", description: T.use_clear },
      },
    },
  },
  {
    name: "codex_review",
    description: T.review_d,
    inputSchema: {
      type: "object",
      properties: {
        base: { type: "string", description: T.review_base },
        focus: { type: "string", description: T.review_focus },
        background: { type: "boolean", default: true },
        model: { type: "string" },
        effort: { type: "string", enum: EFFORT_SET, description: EFFORT_DESC },
      },
    },
  },
  {
    name: "codex_challenge",
    description: T.challenge_d,
    inputSchema: {
      type: "object",
      properties: {
        focus: { type: "string", description: T.challenge_focus },
        base: { type: "string", description: T.review_base },
        background: { type: "boolean", default: true },
        model: { type: "string" },
        effort: { type: "string", enum: EFFORT_SET, description: EFFORT_DESC },
      },
    },
  },
  {
    name: "codex_delegate",
    description: T.delegate_d,
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: T.delegate_task },
        model: { type: "string" },
        effort: { type: "string", enum: EFFORT_SET, description: EFFORT_DESC },
        wait_seconds: { type: "number", default: 120, description: T.delegate_wait },
      },
      required: ["task"],
    },
  },
  {
    name: "codex_models",
    description: T.models_d,
    inputSchema: {
      type: "object",
      properties: {
        refresh: { type: "boolean", description: T.models_refresh },
      },
    },
  },
  {
    name: "codex_progress",
    description: T.progress_d,
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "string", description: T.progress_job },
        limit: { type: "number", default: 12, description: T.progress_limit },
        detail: { type: "boolean", default: false, description: T.progress_detail },
        wait_seconds: { type: "number", description: T.progress_wait },
      },
    },
  },
  {
    name: "codex_status",
    description: T.status_d,
    inputSchema: {
      type: "object",
      properties: { job_id: { type: "string", description: T.status_job } },
    },
  },
  {
    name: "codex_result",
    description: T.result_d,
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "string", description: T.result_job },
        tail: { type: "number", description: T.result_tail },
      },
    },
  },
  {
    name: "codex_cancel",
    description: T.cancel_d,
    inputSchema: {
      type: "object",
      properties: { job_id: { type: "string" } },
    },
  },
];

const CLI_TOOLS = new Set([
  "codex_ask",
  "codex_chat",
  "codex_delegate",
  "codex_review",
  "codex_challenge",
  "codex_models",
]);

async function guard() {
  const c = await probeCodex();
  if (c.reason === "not_installed") {
    return U().not_installed;
  }
  if (c.reason === "not_logged_in") {
    return U().not_logged_in;
  }
  if (c.reason === "probe_timeout") {
    return U().probe_timeout;
  }
  return null;
}

function fmtJob(j) {
  const dur = j.finishedAt
    ? U().job_finished_ago(humanAge(j.startedAt))
    : U().job_running_for(humanAge(j.startedAt));
  return `${j.id}  [${j.status}]  ${j.mode}${j.model ? ` (${j.model})` : ""}  — ${dur}${j.label ? `\n    ${j.label}` : ""}`;
}

// ------------------------------------------------------------------- рендеринг

// Лента хода работы не должна вытеснять из контекста Claude сам ответ.
const TRAIL_MAX_CHARS = 4000;
const REASONING_MAX_CHARS = 700;

/**
 * Ход работы модели в читаемом виде: одна строка на шаг, а для сводок
 * размышлений — их текст. Полный журнал остаётся на диске: в ответ он не идёт.
 */
function renderTrail(entries, { detail = false, asked = null } = {}) {
  const lines = [];
  let budget = TRAIL_MAX_CHARS;
  let prev = null;
  // Лента начинается с вопроса: без него видно, чем модель занята, но не
  // видно задачи, и читателю остаётся угадывать её по действиям.
  if (asked) {
    lines.push(`  · ${asked}`);
    budget -= asked.length;
  }
  for (const e of entries) {
    if (e.title === prev) continue; // item.updated приходит пачками
    prev = e.title;
    let line = `  · ${e.title}`;
    if (detail && e.kind === "reasoning" && e.detail && e.detail.length > e.title.length) {
      const body = e.detail.length > REASONING_MAX_CHARS ? `${e.detail.slice(0, REASONING_MAX_CHARS)}…` : e.detail;
      line = `  · ${e.title}\n${body
        .split("\n")
        .map((l) => `      ${l}`)
        .join("\n")}`;
    }
    budget -= line.length;
    if (budget < 0) {
      lines.push(U().trail_truncated);
      break;
    }
    lines.push(line);
  }
  return lines.join("\n");
}

/** Ответ модели вместе с тем, как она к нему шла. */
function renderRun(jobId, answer, { detail = true, asked = null } = {}) {
  const trail = renderTrail(jobTrail(jobId, { limit: 60 }), { detail, asked });
  return (trail ? `${U().trail_header}
${trail}

` : "") + `${U().answer_header}

${answer}`;
}

// -------------------------------------------------------------------- вызовы

// Размышления и план модель шлёт потоком, обновляя один и тот же пункт по
// многу раз — их можно схлопывать. Всё остальное — запуски команд, вызовы
// инструментов, правки файлов, поиск, сообщения и отказы — это шаги, каждый
// из которых случился ровно один раз, и терять их нельзя.
const NOISY_KINDS = new Set(["reasoning", "todo"]);

const notifier = (ctx) => (e) => {
  const n = normalize(e);
  if (!n?.title) return;
  ctx?.notify?.(n.title, { keep: !NOISY_KINDS.has(n.kind) });
};

function applyDefaults(args, cwd) {
  const prefs = readPrefs(repoKey(cwd));
  return {
    model: args.model || prefs.model || undefined,
    effort: args.effort || prefs.effort || undefined,
  };
}

/**
 * Отказы «занято» — не сбой сервера, а нормальный ответ: предел параллельных
 * задач или занятый тред чата. Без этого они уходили клиенту как -32603.
 */
async function handleTool(name, args, ctx = {}) {
  try {
    return await dispatchTool(name, args, ctx);
  } catch (e) {
    if (e?.busy) return err(e.message || String(e));
    throw e;
  }
}

async function dispatchTool(name, args, ctx = {}) {
  if (CLI_TOOLS.has(name)) {
    const problem = await guard();
    if (problem) return err(problem);
  }
  const cwd = envClean("TANDEM_CWD") || envClean("CLAUDE_PROJECT_DIR") || process.cwd();

  if (args.effort) {
    const bad = validateEffort(args.model, args.effort);
    if (bad) return err(U().effort_hint(bad));
  }

  if (args.model) {
    // Каталог отстаёт от реальной доступности, поэтому он предупреждает, а не
    // запрещает: отказ по каталогу однажды заблокировал уже работавшую модель.
    const k = knownModel(args.model);
    if (k.unverified && k.available?.length) ctx?.notify?.(U().model_unverified(args.model, k.available.join(", ")));
  }

  // Лента открывается вопросом, а не первым действием Codex: иначе в клиенте
  // видно, что модель что-то делает, но не видно, о чём её спросили.
  const asked = askedLine(args);
  if (asked) ctx?.notify?.(asked);

  switch (name) {
    case "codex_ask": {
      const waitMs = Math.max(10, Number(args.wait_seconds) || 90) * 1000;
      const r = await runJob(
        { mode: "ask", cwd, ...args, ...applyDefaults(args, cwd) },
        { waitMs, onEvent: notifier(ctx), signal: ctx.signal }
      );
      if (r.aborted) return text(U().cancelled(r.job.id));
      if (r.timedOut) {
        // Работа не перезапускается: тот же процесс продолжает идти в фоне.
        return text(
          `${U().timed_out(Math.round(waitMs / 1000), r.job.id)}\n\n` +
            `${renderTrail(jobTrail(r.job.id, { limit: 20 }), { asked })}\n\n` +
            U().follow_answer
        );
      }
      if (!r.ok) return err(r.error);
      return text(renderRun(r.job.id, r.output, { asked }));
    }

    case "codex_chat": {
      if (!args.message) return err(U().need_message);
      const slug = args.chat || "default";
      if (!isValidSlug(slug)) {
        return err(U().bad_chat_name(JSON.stringify(slug)));
      }
      const waitMs = Math.max(10, Number(args.wait_seconds) || 120) * 1000;

      try {
        return await withChatLock(slug, async () => {
          const chat = readChat(slug);
          const defaults = applyDefaults(args, cwd);
          // Модель, effort и каталог повторяются при каждом ходе: без них
          // Codex молча возьмёт текущие значения по умолчанию и разговор
          // уедет на другую модель.
          const model = args.model || chat?.model || defaults.model;
          const effort = args.effort || chat?.effort || defaults.effort;
          const chatCwd = chat?.cwd || cwd;
          const sandbox = args.write ? "workspace-write" : chat?.sandbox || "read-only";

          const r = await runJob(
            {
              mode: "chat",
              cwd: chatCwd,
              message: args.message,
              context: chat ? undefined : args.context,
              model,
              effort,
              sandbox,
              chat: slug,
              resume: chat?.threadId || null,
            },
            { waitMs, onEvent: notifier(ctx), signal: ctx.signal }
          );

          if (r.aborted) return text(U().cancelled_chat(r.job.id, slug));
          if (r.timedOut) {
            return text(
              `${U().chat_timed_out(Math.round(waitMs / 1000), r.job.id, slug)}\n\n` +
                renderTrail(jobTrail(r.job.id, { limit: 20 }), { asked })
            );
          }
          if (!r.ok) {
            // Пропавший тред — явная ошибка: молча начать новый разговор
            // значит потерять всю прежнюю переписку без предупреждения.
            if (
              chat?.threadId &&
              /(session|thread|rollout|conversation)[^\n]{0,60}(not found|no such|missing|does not exist)|no sessions found/i.test(
                r.error || ""
              )
            ) {
              return err(U().chat_thread_lost(slug, chat.threadId, r.error));
            }
            return err(r.error);
          }

          const threadId = chat?.threadId || jobThreadId(r.job.id);
          writeChat({
            slug,
            model: model || null,
            effort: effort || null,
            sandbox,
            threadId: threadId || null,
            cwd: chatCwd,
            turns: (chat?.turns || 0) + 1,
            updatedAt: new Date().toISOString(),
          });

          const head = U().chat_head(slug, model, (chat?.turns || 0) + 1, !threadId);
          return text(`${head}\n\n${renderRun(r.job.id, r.output)}`);
        });
      } catch (e) {
        if (e?.busy) return err(String(e.message));
        throw e;
      }
    }

    case "codex_chats": {
      if (args.forget) {
        if (!isValidSlug(args.forget)) return err(U().bad_chat_name(JSON.stringify(args.forget)));
        return deleteChat(args.forget)
          ? text(U().chat_forgotten(args.forget))
          : err(U().chat_not_found(args.forget));
      }
      const chats = listChats();
      if (!chats.length) return text(U().no_chats);
      return text(
        chats
          .map(
            (c) =>
              U().chat_line(c.slug, c.model, c.effort, c.turns || 0, humanAge(c.updatedAt), !c.threadId, c.cwd)
          )
          .join("\n")
      );
    }

    case "codex_use": {
      const repo = repoKey(cwd);
      if (args.clear) {
        writePrefs(repo, { model: null, effort: null });
        return text(U().prefs_cleared);
      }
      if (!args.model && !args.effort) {
        const p = readPrefs(repo);
        return text(
          U().prefs_current(p.model || U().from_settings, p.effort || U().from_settings)
        );
      }
      const p = writePrefs(repo, {
        model: args.model === undefined ? undefined : args.model || null,
        effort: args.effort === undefined ? undefined : args.effort || null,
      });
      return text(
        U().prefs_set(p.model || U().from_settings, p.effort || U().from_settings, repo)
      );
    }

    case "codex_progress": {
      const j = resolveJob(args.job_id, cwd);
      if (!j) return err(U().job_not_found);

      // Ожидание новых событий: то же наблюдение, что и у синхронного вызова,
      // но по уже запущенной задаче.
      if (args.wait_seconds) {
        await followJob(j.id, {
          timeoutMs: Math.max(1, Number(args.wait_seconds)) * 1000,
          onEvent: notifier(ctx),
          signal: ctx.signal,
        });
      }

      const p = jobProgress(j.id, { limit: Number(args.limit) || 12 });
      if (!p.hasEvents) {
        return text(
          U().no_events_yet(j.id, j.status, humanAge(j.startedAt))
        );
      }
      const entries = jobTrail(j.id, { limit: Number(args.limit) || 12 });
      return text(
        `${U().progress_head(j.id, j.status, humanAge(j.startedAt))}\n\n` +
          renderTrail(entries, { detail: args.detail === true }) +
          (p.finished ? U().progress_finished : "")
      );
    }

    case "codex_review":
    case "codex_challenge": {
      const mode = name === "codex_review" ? "review" : "challenge";
      const backend = mode === "review" ? reviewBackend() : "exec";
      const background = args.background !== false;
      // Сбор контекста теперь отказывает явно: не репозиторий, несуществующая
      // база, сбойный git. Раньше любая из этих причин давала пустой диф и
      // ревью «ни о чём», поэтому отказ доносим как есть, а не как сбой сервера.
      // Промпт строится здесь же и передаётся готовым: иначе git-диф собирался
      // бы дважды — на проверке и на запуске.
      let prompt = null;
      let diffError = null;
      try {
        prompt = buildPrompt({ mode, cwd, ...args });
      } catch (e) {
        diffError = e;
      }
      // Нативный reviewer получает структурную цель и диф не читает. Отказ
      // сбора отнимает у него только запасной путь через exec, поэтому
      // блокировать им весь вызов значило бы отказывать работоспособному ревью.
      if (diffError && backend !== "app-server") {
        return err(U().diff_failed(diffError?.message || diffError));
      }
      const spec = {
        mode,
        cwd,
        ...args,
        ...applyDefaults(args, cwd),
        prompt,
        allowFallback: !diffError,
        backend,
        reviewTarget: backend === "app-server" ? appServerReviewTarget(args) : null,
      };
      if (!background) {
        const r = await runJob(spec, { waitMs: 480_000, onEvent: notifier(ctx), signal: ctx.signal });
        if (r.aborted) return text(U().cancelled(r.job.id));
        if (r.timedOut) return text(U().review_timed_out(r.job.id));
        return r.ok ? text(renderRun(r.job.id, r.output, { asked })) : err(r.error);
      }
      const job = startJob(spec);
      return text(
        U().review_started(mode !== "review", job.id)
      );
    }

    case "codex_delegate": {
      if (!args.task) return err(U().need_task);
      const spec = { mode: "delegate", cwd, ...args, ...applyDefaults(args, cwd) };
      // Ноль — прежнее поведение: сразу в фон, без ожидания.
      const waitMs = args.wait_seconds === undefined ? 120_000 : Math.max(0, Number(args.wait_seconds) || 0) * 1000;
      if (waitMs <= 0) {
        const job = startJob(spec);
        return text(
          U().delegated(job.id)
        );
      }
      const r = await runJob(spec, { waitMs, onEvent: notifier(ctx), signal: ctx.signal });
      if (r.aborted) return text(U().cancelled(r.job.id));
      if (r.timedOut) {
        return text(
          `${U().timed_out(Math.round(waitMs / 1000), r.job.id)}\n\n` +
            `${renderTrail(jobTrail(r.job.id, { limit: 20 }), { asked })}\n\n` +
            U().follow_result
        );
      }
      if (!r.ok) return err(r.error);
      return text(renderRun(r.job.id, r.output, { asked }));
    }

    case "codex_models": {
      const r = fetchModels({ force: args.refresh === true });
      return r.ok ? text(formatModels(r)) : err(r.error);
    }

    case "codex_status": {
      if (args.job_id) {
        const j = resolveJob(args.job_id, cwd);
        if (!j) return err(U().job_not_found_id(args.job_id));
        const p = jobProgress(j.id, { limit: 10 });
        const body = p.hasEvents
          ? renderTrail(jobTrail(j.id, { limit: 10 }))
          : jobOutput(j.id, { tail: 15 }) || U().empty_so_far;
        return text(`${fmtJob(j)}\n\n${U().trail_section}\n${body}`);
      }
      const jobs = listJobs(cwd).slice(0, 10);
      if (!jobs.length) return text(U().no_jobs);
      return text(jobs.map(fmtJob).join("\n"));
    }

    case "codex_result": {
      const j = resolveJob(args.job_id, cwd);
      if (!j) return err(U().job_not_found);
      if (j.status === "running") {
        return text(
          `${U().still_running(j.id, humanAge(j.startedAt))}\n\n` +
            (renderTrail(jobTrail(j.id, { limit: 10 })) || jobOutput(j.id, { tail: 30 }))
        );
      }
      const r = jobResult(j.id);
      if (!r.ok) return err(r.error);
      const answer = jobAnswer(j.id) || jobOutput(j.id, args.tail ? { tail: args.tail } : {});
      return text(`${j.id} [${j.status}] — ${j.mode}\n\n${renderRun(j.id, answer || U().empty_output)}`);
    }

    case "codex_cancel": {
      const j = resolveJob(args.job_id, cwd);
      if (!j) return err(U().job_not_found);
      const r = cancelJob(j.id);
      return r.ok ? text(`${j.id}: ${r.note || U().cancelled_note}`) : err(r.error);
    }

    default:
      return err(U().unknown_tool(name));
  }
}

serve({ name: "tandem", version: pluginVersion(), tools: TOOLS, handle: handleTool });
