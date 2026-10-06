import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { dataDir } from "./codex-core.mjs";
import { isValidSlug, withChatLock } from "./chat-store.mjs";
import { effortLevels } from "./models.mjs";
import { collaborationText } from "./i18n-collaboration.mjs";

const T = collaborationText;
const LIMIT = 6;
const REPLY_LIMIT = 16000;
const STALE_MS = 120000;
const HEARTBEAT_MS = 20000;
const PHASES = {
  research: ["explore", "evaluate", "synthesize"],
  brainstorm: ["generate", "evaluate", "synthesize"],
  custom: ["work", "evaluate", "synthesize"],
};
const ACTIONS = ["turn", "status", "extend", "cancel"];
const FIELDS = ["action", "session", "mode", "phase", "message", "context", "summary", "confirm", "model", "effort", "wait_seconds"];
const active = new Map();
const cancellations = new Map();
const own = (value, key) => Object.hasOwn(value, key);
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const text = (value, max) => typeof value === "string" && value.trim().length > 0 && value.length <= max;
const time = (value) => Number.isSafeInteger(value) && value >= 0;
const jobId = (value) => text(value, 200) && !/[\s\x00-\x1f\x7f]/u.test(value);
const metadata = (value) => text(value, 200) && value === value.trim() && !/[\x00-\x1f\x7f]/u.test(value);
const exactKeys = (value, keys) => record(value) && Object.keys(value).length === keys.length && keys.every((key) => own(value, key));

function invalid(detail) {
  throw new Error(T().invalid(detail));
}

function checkBackend(backend) {
  if (!["codex", "claude"].includes(backend)) invalid("backend");
}

/** @returns {{ name: string, description: string, inputSchema: object }} */
export function collaborationTool(backend, { efforts = effortLevels() } = {}) {
  checkBackend(backend);
  if (!Array.isArray(efforts) || !efforts.length || efforts.some((e) => !effortLevels().includes(e))) invalid("efforts");
  const labels = T().fields;
  const string = (field, maxLength) => ({ type: "string", minLength: 1, maxLength, description: labels[field] });
  const properties = {
    action: { type: "string", enum: ACTIONS, default: "turn", description: labels.action },
    session: { ...string("session", 49), pattern: "^[a-zA-Z0-9](?!.*\\.\\.)[a-zA-Z0-9._-]{0,48}$" },
    mode: { type: "string", enum: Object.keys(PHASES), description: labels.mode },
    phase: { type: "string", enum: [...new Set(Object.values(PHASES).flat())], description: labels.phase },
    message: string("message", 12000),
    context: string("context", 12000),
    summary: string("summary", 16000),
    confirm: { type: "boolean", description: labels.confirm },
    model: string("model", 200),
  };
  if (backend === "codex") {
    properties.effort = { type: "string", enum: [...new Set(efforts)], description: labels.effort };
    properties.wait_seconds = { type: "number", minimum: 0, description: labels.wait_seconds };
  }
  return {
    name: `${backend}_collaborate`,
    description: T().description,
    inputSchema: { type: "object", properties, required: ["session"], additionalProperties: false },
  };
}

function validateArgs(args, backend) {
  if (!record(args) || Reflect.ownKeys(args).some((key) => !FIELDS.includes(key))) invalid("unknown fields");
  if (!isValidSlug(args.session)) invalid("session");
  const action = own(args, "action") ? args.action : "turn";
  if (!ACTIONS.includes(action)) invalid("action");
  if (own(args, "mode") && (typeof args.mode !== "string" || !own(PHASES, args.mode))) invalid("mode");
  if (own(args, "phase") && !Object.values(PHASES).some((phases) => phases.includes(args.phase))) invalid("phase");
  for (const [key, max] of [["message", 12000], ["context", 12000], ["summary", 16000]]) {
    if (own(args, key) && !text(args[key], max)) invalid(key);
  }
  if (own(args, "model") && !metadata(args.model)) invalid("model");
  if (own(args, "effort") && (backend !== "codex" || !effortLevels().includes(args.effort))) invalid("effort");
  if (own(args, "wait_seconds") && (backend !== "codex" || typeof args.wait_seconds !== "number" || !Number.isFinite(args.wait_seconds) || args.wait_seconds < 0)) invalid("wait_seconds");
  if (own(args, "confirm") && typeof args.confirm !== "boolean") invalid("confirm");
  if (action !== "turn" && ["message", "context", "phase"].some((key) => own(args, key))) invalid("turn-only fields");
  if (!["turn", "status"].includes(action) && own(args, "wait_seconds")) invalid("wait_seconds");
  if (action !== "extend" && ["confirm", "summary"].some((key) => own(args, key))) invalid("extend-only fields");
  if (action === "turn" && !own(args, "message")) invalid("message required");
  if (action === "extend" && (args.confirm !== true || !own(args, "summary"))) invalid("extend requires confirm:true and summary");
  return { ...args, action, session: args.session.toLowerCase() };
}

function excerpt(value) {
  if (value === null) return { value: null, truncated: false };
  if (value.length <= REPLY_LIMIT) return { value, truncated: false };
  const marker = T().truncated;
  return { value: value.slice(0, REPLY_LIMIT - marker.length) + marker, truncated: true };
}

function phaseAllowed(mode, current, next, successful) {
  const phases = PHASES[mode];
  return phases.includes(next) && phases.indexOf(next) >= phases.indexOf(current) &&
    !(mode === "brainstorm" && ((next === "evaluate" && !successful.has("generate")) || (next === "synthesize" && !successful.has("evaluate"))));
}

function stageStatus(entries) {
  if (entries.some((entry) => entry.status === "pending")) return "pending";
  if (entries.some((entry) => entry.status === "completed" && entry.phase === "synthesize")) return "complete";
  return entries.length === LIMIT ? "exhausted" : "active";
}

function errorText(error) {
  return error instanceof Error ? error.message || error.name : String(error || "Runner failed");
}

function aborted(signal) {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
}

/**
 * Runner.start получает signal и onStarted в ctx. Codex обязан await onStarted(jobId)
 * до ожидания результата. Runner и адаптер обеспечивают реальную изоляцию read-only:
 * промпт не заменяет sandbox. Модель/effort по умолчанию адаптер разрешает до создания.
 */
export class CollaborationSession {
  constructor({ backend, cwd, runner, defaults = {} }) {
    checkBackend(backend);
    // Значения по умолчанию фиксируются при создании сессии, а не на каждом ходе:
    // смена настроек не должна молча переключить модель посреди диалога.
    this.defaults = {
      model: metadata(defaults.model) ? defaults.model : null,
      effort: backend === "codex" && effortLevels().includes(defaults.effort) ? defaults.effort : null,
    };
    if (!text(cwd, 32768) || !runner || typeof runner.start !== "function") invalid("cwd/runner");
    if (backend === "codex" && ["poll", "cancel"].some((method) => typeof runner[method] !== "function")) invalid("Codex runner.poll/cancel");
    const canonical = fs.realpathSync(cwd);
    if (!fs.statSync(canonical).isDirectory()) invalid("cwd");
    this.backend = backend;
    this.cwd = process.platform === "win32" ? canonical.toLowerCase() : canonical;
    this.runner = runner;
  }

  #scope(session) {
    const hash = createHash("sha256").update(JSON.stringify([this.cwd, this.backend, session])).digest("hex");
    const base = path.dirname(dataDir());
    const outsideWorkspace = (directory) => {
      const relative = path.relative(this.cwd, fs.realpathSync(directory));
      if (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`)) invalid("collaboration storage must be outside cwd");
    };
    outsideWorkspace(base);
    const dir = path.join(base, "collaborations");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    outsideWorkspace(dir);
    fs.chmodSync(dir, 0o700);
    return { hash, file: path.join(dir, `${hash}.json`), lock: `collab-${hash.slice(0, 40)}`, session };
  }

  async #locked(scope, fn) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await withChatLock(scope.lock, () => {
          const lockPath = path.join(path.dirname(path.dirname(scope.file)), "chats", `${scope.lock}.lock`);
          fs.chmodSync(path.dirname(lockPath), 0o700);
          fs.chmodSync(lockPath, 0o700);
          return fn();
        });
      } catch (error) {
        if (!error.busy || attempt >= 100) throw error;
        await delay(10);
      }
    }
  }

  #validateState(state, scope) {
    const fail = () => { throw new Error(T().corrupt(scope.file)); };
    if (!exactKeys(state, ["schemaVersion", "scope", "cwd", "backend", "session", "mode", "model", "effort", "stage", "roundsUsed", "phase", "status", "context", "summary", "transcript", "extensions", "pending", "createdAt", "updatedAt"])) fail();
    if (!record(state) || state.schemaVersion !== 1 || state.scope !== scope.hash || state.cwd !== this.cwd || state.backend !== this.backend || state.session !== scope.session || typeof state.mode !== "string" || !own(PHASES, state.mode)) fail();
    if (!(state.model === null || metadata(state.model)) || !(state.effort === null || (this.backend === "codex" && effortLevels().includes(state.effort)))) fail();
    if (!Number.isSafeInteger(state.stage) || state.stage < 1 || !time(state.createdAt) || !time(state.updatedAt) || state.updatedAt < state.createdAt) fail();
    if (!(state.context === null || text(state.context, 12000)) || !(state.summary === null || text(state.summary, 16000)) || !Array.isArray(state.transcript) || !Array.isArray(state.extensions) || state.extensions.length !== state.stage - 1) fail();
    for (const [index, extension] of state.extensions.entries()) {
      if (!exactKeys(extension, ["stage", "summary", "at"]) || extension.stage !== index + 2 || !text(extension.summary, 16000) || !time(extension.at)) fail();
    }
    if (state.summary !== (state.extensions.at(-1)?.summary ?? null)) fail();
    const ids = new Set();
    let offset = 0;
    let currentEntries = [];
    let currentPhase;
    for (let stage = 1; stage <= state.stage; stage++) {
      const entries = [];
      const successful = new Set();
      let phase = PHASES[state.mode][0];
      while (offset < state.transcript.length && state.transcript[offset]?.stage === stage) {
        const entry = state.transcript[offset++];
        if (!exactKeys(entry, ["id", "stage", "round", "phase", "message", "status", "output", "error", "startedAt", "finishedAt"])) fail();
        if (!record(entry) || !text(entry.id, 80) || ids.has(entry.id) || entry.round !== entries.length + 1 || entry.round > LIMIT || !text(entry.message, 12000) || !time(entry.startedAt) || !["pending", "completed", "failed", "cancelled"].includes(entry.status)) fail();
        if (stageStatus(entries) !== "active" || !phaseAllowed(state.mode, phase, entry.phase, successful)) fail();
        ids.add(entry.id);
        if (entry.status === "completed") {
          if (typeof entry.output !== "string" || entry.error !== null || !time(entry.finishedAt)) fail();
          phase = entry.phase;
          successful.add(phase);
        } else if (entry.output !== null) fail();
        if (["failed", "cancelled"].includes(entry.status) && (!text(entry.error, Infinity) || !time(entry.finishedAt))) fail();
        if (entry.status === "pending" && (entry.error !== null || entry.finishedAt !== null || stage !== state.stage || offset !== state.transcript.length)) fail();
        entries.push(entry);
      }
      if (stage < state.stage && entries.some((entry) => entry.status === "pending")) fail();
      currentEntries = entries;
      currentPhase = phase;
    }
    if (offset !== state.transcript.length || state.roundsUsed !== currentEntries.length || state.phase !== currentPhase || state.status !== stageStatus(currentEntries)) fail();
    if (state.status === "pending") {
      if (!exactKeys(state.pending, ["id", "jobId", "heartbeatAt", "cancelRequested"]) || state.pending.id !== currentEntries.at(-1).id || !time(state.pending.heartbeatAt) || typeof state.pending.cancelRequested !== "boolean" || !(state.pending.jobId === null || (this.backend === "codex" && jobId(state.pending.jobId)))) fail();
    } else if (state.pending !== null) fail();
  }

  #read(scope) {
    let raw;
    try {
      raw = fs.readFileSync(scope.file, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
    let state;
    try {
      state = JSON.parse(raw);
      this.#validateState(state, scope);
    } catch {
      throw new Error(T().corrupt(scope.file));
    }
    return state;
  }

  #save(scope, state) {
    state.updatedAt = Date.now();
    this.#validateState(state, scope);
    const staging = `${scope.file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(staging, JSON.stringify(state), { mode: 0o600, flag: "wx" });
      fs.chmodSync(staging, 0o600);
      fs.renameSync(staging, scope.file);
    } finally {
      try { fs.unlinkSync(staging); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }

  #newState(scope, args) {
    if (!args.mode) invalid("mode required at creation");
    const now = Date.now();
    return {
      schemaVersion: 1, scope: scope.hash, cwd: this.cwd, backend: this.backend, session: args.session,
      mode: args.mode, model: args.model ?? this.defaults.model, effort: args.effort ?? this.defaults.effort,
      stage: 1, roundsUsed: 0, phase: PHASES[args.mode][0], status: "active",
      context: args.context ?? null, summary: null, transcript: [], extensions: [], pending: null,
      createdAt: now, updatedAt: now,
    };
  }

  #checkExisting(state, args) {
    for (const key of ["mode", "model", "effort"]) {
      if (own(args, key) && args[key] !== state[key]) throw new Error(T().immutable(key));
    }
    if (own(args, "context")) throw new Error(T().contextLater);
    if (own(args, "phase") && !PHASES[state.mode].includes(args.phase)) throw new Error(T().phaseOrder);
  }

  #finish(state, result, cancelled = false) {
    const entry = state.transcript.at(-1);
    if (cancelled || state.pending.cancelRequested) {
      entry.status = "cancelled";
      entry.error = T().cancelled;
    } else if (result.ok) {
      entry.status = "completed";
      entry.output = result.output;
      state.phase = entry.phase;
    } else {
      entry.status = "failed";
      entry.error = result.error;
    }
    entry.finishedAt = Date.now();
    state.pending = null;
    state.status = stageStatus(state.transcript.filter((turn) => turn.stage === state.stage));
  }

  #recover(scope, state) {
    if (state.pending && !state.pending.jobId && Date.now() - state.pending.heartbeatAt > STALE_MS && active.get(scope.file)?.id !== state.pending.id) {
      this.#finish(state, { ok: false, error: T().orphan });
      this.#save(scope, state);
    }
  }

  #snapshot(scope, state) {
    const last = state.transcript.findLast((entry) => entry.status !== "pending");
    const reply = excerpt(last?.output ?? null);
    const error = excerpt(last?.error ?? null);
    return {
      session: state.session, backend: state.backend, stage: state.stage,
      roundsUsed: state.roundsUsed, roundsRemaining: LIMIT - state.roundsUsed,
      status: state.status, phase: state.phase, mode: state.mode, model: state.model, effort: state.effort,
      pending: state.pending ? { jobId: state.pending.jobId } : null,
      latest: { reply: reply.value, error: error.value, truncated: reply.truncated || error.truncated },
      state_file: scope.file,
    };
  }

  #prompt(scope, state, entry) {
    const strings = T();
    const payload = {
      session: state.session, mode: state.mode, phase: entry.phase, stage: state.stage,
      state_file: scope.file,
      roundsUsed: state.roundsUsed, roundsRemaining: LIMIT - state.roundsUsed,
      ...(state.stage === 1 ? { context: state.context } : { summary: state.summary }),
      turns: state.transcript.filter((turn) => turn.stage === state.stage && turn.status === "completed").map((turn) => {
        const reply = excerpt(turn.output);
        return { phase: turn.phase, message: turn.message, reply: reply.value, truncated: reply.truncated };
      }),
      message: entry.message,
    };
    return `${strings.safety}\n${strings.modes[state.mode]}\n${strings.phases[entry.phase]}\n\nDATA_JSON:\n${JSON.stringify(payload)}`;
  }

  #options(state, args) {
    return { model: state.model ?? undefined, effort: state.effort ?? undefined, wait_seconds: args.wait_seconds };
  }

  async #settle(scope, id, result, polled = false) {
    return this.#locked(scope, () => {
      const state = this.#read(scope);
      if (!state) throw new Error(T().missing);
      if (state.pending?.id === id) {
        if (result.pending) {
          if (state.pending.jobId !== result.jobId) throw new Error(T().runner);
        } else if (!state.pending.cancelRequested || polled) {
          this.#finish(state, result);
          this.#save(scope, state);
        }
      }
      return this.#snapshot(scope, state);
    });
  }

  #result(result, published) {
    if (!record(result)) throw new Error(T().runner);
    if (result.pending === true && result.ok === undefined && this.backend === "codex" && jobId(result.jobId) && result.jobId === published) return result;
    if (result.pending === undefined && result.ok === true && typeof result.output === "string" && (this.backend !== "codex" || published)) return result;
    if (result.pending === undefined && result.ok === false && text(result.error, Infinity)) return result;
    throw new Error(T().runner);
  }

  async #cancel(scope, id) {
    const key = `${scope.file}:${id}`;
    if (cancellations.has(key)) return cancellations.get(key);
    const cancellation = this.#cancelRound(scope, id);
    cancellations.set(key, cancellation);
    try {
      return await cancellation;
    } finally {
      if (cancellations.get(key) === cancellation) cancellations.delete(key);
    }
  }

  async #cancelRound(scope, id) {
    const target = await this.#locked(scope, () => {
      const state = this.#read(scope);
      if (state?.pending?.id !== id) return null;
      state.pending.cancelRequested = true;
      this.#save(scope, state);
      return { jobId: state.pending.jobId };
    });
    if (target?.jobId) {
      const result = await this.runner.cancel(target.jobId);
      if (result?.ok === false) throw new Error(errorText(result.error));
    }
    return this.#locked(scope, () => {
      const state = this.#read(scope);
      if (!state) throw new Error(T().missing);
      if (state.pending?.id === id) {
        this.#finish(state, { ok: false, error: T().cancelled }, true);
        this.#save(scope, state);
      }
      return this.#snapshot(scope, state);
    });
  }

  async #start(scope, operation, ctx) {
    const { id, controller, prompt, options } = operation;
    let published = null;
    let acceptingJob = true;
    const relayAbort = () => controller.abort(ctx.signal.reason);
    ctx.signal?.addEventListener("abort", relayAbort, { once: true });
    if (ctx.signal?.aborted) relayAbort();
    let abortListener;
    const cancelled = new Promise((resolve) => {
      abortListener = () => resolve({ cancelled: true });
      controller.signal.addEventListener("abort", abortListener, { once: true });
      if (controller.signal.aborted) abortListener();
    });
    const beat = setInterval(() => {
      void this.#locked(scope, () => {
        const state = this.#read(scope);
        if (state?.pending?.id === id) {
          state.pending.heartbeatAt = Date.now();
          this.#save(scope, state);
        }
      }).catch((error) => controller.abort(error));
    }, HEARTBEAT_MS);
    beat.unref?.();
    const onStarted = async (value) => {
      if (this.backend !== "codex" || !jobId(value) || (published && published !== value)) throw new Error(T().runner);
      const accepted = await this.#locked(scope, () => {
        const state = this.#read(scope);
        if (!acceptingJob || state?.pending?.id !== id || state.pending.cancelRequested) return false;
        if (state.pending.jobId && state.pending.jobId !== value) throw new Error(T().runner);
        state.pending.jobId = value;
        state.pending.heartbeatAt = Date.now();
        this.#save(scope, state);
        published = value;
        return true;
      });
      if (!accepted || controller.signal.aborted) {
        await this.runner.cancel(value);
        throw new DOMException("Aborted", "AbortError");
      }
      await ctx.onStarted?.(value);
    };
    try {
      const work = Promise.resolve().then(async () => {
        aborted(controller.signal);
        return this.#result(await this.runner.start(prompt, options, { ...ctx, signal: controller.signal, onStarted }), published);
      }).then((result) => ({ result }), (error) => ({ error, failed: true }));
      const outcome = await Promise.race([work, cancelled]);
      if (outcome.cancelled || controller.signal.aborted) return await this.#cancel(scope, id);
      // Сбой ожидания после публикации не доказывает, что фоновое задание завершено.
      if (outcome.failed && published) throw outcome.error;
      const result = outcome.failed ? { ok: false, error: errorText(outcome.error) } : outcome.result;
      if (!result.pending) acceptingJob = false;
      return await this.#settle(scope, id, result);
    } finally {
      acceptingJob = false;
      clearInterval(beat);
      ctx.signal?.removeEventListener("abort", relayAbort);
      controller.signal.removeEventListener("abort", abortListener);
      if (active.get(scope.file)?.id === id) active.delete(scope.file);
    }
  }

  async handle(input, ctx = {}) {
    const args = validateArgs(input, this.backend);
    const scope = this.#scope(args.session);
    if (args.action === "cancel") {
      const state = this.#read(scope);
      if (state) this.#checkExisting(state, args);
      const running = active.get(scope.file);
      if (running && running.id === state?.pending?.id) running.controller.abort();
    }
    const operation = await this.#locked(scope, () => {
      let state = this.#read(scope);
      if (!state) {
        if (args.action !== "turn") throw new Error(T().missing);
        state = this.#newState(scope, args);
      } else {
        this.#checkExisting(state, args);
        this.#recover(scope, state);
      }
      if (args.action === "cancel") {
        return state.pending ? { kind: "cancel", id: state.pending.id } : { snapshot: this.#snapshot(scope, state) };
      }
      if (args.action === "status") {
        return state.pending?.jobId ? { kind: "poll", id: state.pending.id, jobId: state.pending.jobId, options: this.#options(state, args) } : { snapshot: this.#snapshot(scope, state) };
      }
      if (args.action === "extend") {
        if (state.pending) throw new Error(T().pending);
        state.stage++;
        state.roundsUsed = 0;
        state.phase = PHASES[state.mode][0];
        state.status = "active";
        state.summary = args.summary;
        state.extensions.push({ stage: state.stage, summary: args.summary, at: Date.now() });
        this.#save(scope, state);
        return { snapshot: this.#snapshot(scope, state) };
      }
      if (state.pending) return { snapshot: this.#snapshot(scope, state) };
      if (state.status !== "active") throw new Error(T().closed);
      const phase = args.phase ?? state.phase;
      const successful = new Set(state.transcript.filter((turn) => turn.stage === state.stage && turn.status === "completed").map((turn) => turn.phase));
      if (!phaseAllowed(state.mode, state.phase, phase, successful)) throw new Error(T().phaseOrder);
      aborted(ctx.signal);
      const entry = {
        id: randomUUID(), stage: state.stage, round: state.roundsUsed + 1, phase, message: args.message,
        status: "pending", output: null, error: null, startedAt: Date.now(), finishedAt: null,
      };
      state.transcript.push(entry);
      state.roundsUsed++;
      state.pending = { id: entry.id, jobId: null, heartbeatAt: Date.now(), cancelRequested: false };
      state.status = "pending";
      this.#save(scope, state);
      const controller = new AbortController();
      active.set(scope.file, { id: entry.id, controller });
      return { kind: "start", id: entry.id, controller, prompt: this.#prompt(scope, state, entry), options: this.#options(state, args) };
    });
    if (operation.snapshot) return operation.snapshot;
    if (operation.kind === "start") return this.#start(scope, operation, ctx);
    if (operation.kind === "cancel") return this.#cancel(scope, operation.id);
    // Ошибка транспорта при poll не доказывает завершение задания: jobId сохраняется.
    const result = this.#result(await this.runner.poll(operation.jobId, operation.options, ctx), operation.jobId);
    return this.#settle(scope, operation.id, result, true);
  }
}
