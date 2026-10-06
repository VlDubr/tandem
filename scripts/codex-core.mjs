// codex-core.mjs — обёртка над Codex CLI + менеджер фоновых задач.
// Никаких внешних зависимостей: только node:*.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import {
  extractOutput,
  progressTrail,
  isFinished,
  parseStream,
  parseLine,
  normalizeStream,
  threadIdOf,
  hasStreamTags,
  streamText,
  usageOf,
} from "./codex-events.mjs";
import { alive, killTree } from "./proc.mjs";
import { prompt, uiText, coreText } from "./i18n.mjs";

// Тексты берутся на каждый вызов: язык задаётся окружением процесса.
const C = coreText;

// ---------------------------------------------------------------- пути и стор

/**
 * Читает переменную окружения, отбрасывая нераскрытые плейсхолдеры.
 *
 * Claude Code подставляет ${CLAUDE_PLUGIN_DATA} и ${user_config.KEY} в env
 * MCP-сервера, но подстановка может не произойти — например, когда поле
 * userConfig оставлено пустым. Тогда в переменную попадает литеральная строка
 * "${...}", и дальше она молча используется как значение: относительный путь
 * превращается в каталог с именем плейсхолдера, а имя модели — в мусор,
 * который отвергнет Codex. Проверка одна и на всех.
 */
export function envClean(name) {
  const v = process.env[name];
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  if (!t || /^\$\{.*\}$/.test(t)) return undefined;
  return t;
}

const JOB_ID_RE = /^job-[0-9a-f]{8}$/;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export function dataDir() {
  const fromEnv = envClean("CLAUDE_PLUGIN_DATA");
  // Только абсолютный путь: относительный создал бы служебный каталог прямо
  // в проекте пользователя.
  const base =
    fromEnv && path.isAbsolute(fromEnv)
      ? fromEnv
      : path.join(os.homedir(), ".claude", "plugins", "data", "tandem");
  const dir = path.join(base, "jobs");
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  try {
    fs.chmodSync(dir, DIR_MODE);
  } catch {}
  return dir;
}

/**
 * Единственная точка, где идентификатор превращается в путь.
 * Формат жёсткий, плюс проверка containment после resolve: идентификаторы
 * приходят от модели, поэтому "../../etc/passwd" здесь вполне вероятен.
 */
function jobPath(id, ext) {
  if (typeof id !== "string" || !JOB_ID_RE.test(id)) {
    throw new Error(C().bad_job_id(JSON.stringify(id)));
  }
  const dir = dataDir();
  const p = path.resolve(dir, `${id}.${ext}`);
  if (path.dirname(p) !== path.resolve(dir)) {
    throw new Error(C().job_path_escape(id));
  }
  return p;
}

export function isValidJobId(id) {
  return typeof id === "string" && JOB_ID_RE.test(id);
}

function writeFileSecure(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, { mode: FILE_MODE });
  fs.renameSync(tmp, file); // атомарная замена в пределах одной ФС
}

function readJob(id) {
  try {
    return JSON.parse(fs.readFileSync(jobPath(id, "json"), "utf8"));
  } catch {
    return null;
  }
}

function writeJob(job) {
  writeFileSecure(jobPath(job.id, "json"), JSON.stringify(job, null, 2));
  return job;
}

export function repoKey(cwd) {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
  return (r.status === 0 ? r.stdout.trim() : cwd) || cwd;
}

// --------------------------------------------------------------- поиск codex

export function codexBinary() {
  return envClean("CODEX_BIN") || "codex";
}

const CODEX_PROBE_TIMEOUT_MS = 4_000;
const CODEX_PROBE_TTL_MS = 60_000;

let probePromise = null;
let probeCache = null;

function spawnTimedOut(result) {
  return result.error?.code === "ETIMEDOUT" || result.error?.errno === "ETIMEDOUT";
}

function runProbe(bin, args) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer;
    let child;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr, ...result });
    };

    try {
      child = spawn(bin, args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      finish({ error, status: null });
      return;
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => finish({ error, status: null }));
    child.on("close", (status, signal) => finish({ error: null, status, signal }));

    timer = setTimeout(() => {
      if (settled) return;
      killTree(child.pid);
      finish({ error: null, status: null, timedOut: true });
    }, CODEX_PROBE_TIMEOUT_MS);
  });
}

export async function probeCodex({ force = false } = {}) {
  if (probePromise) return probePromise;

  const now = Date.now();
  if (!force && probeCache && now - probeCache.at < CODEX_PROBE_TTL_MS) {
    return probeCache.result;
  }

  const bin = codexBinary();
  const current = (async () => {
    const v = await runProbe(bin, ["--version"]);
    let result;
    if (v.timedOut) {
      result = { ok: false, reason: "probe_timeout", bin };
    } else if (v.error) {
      result = { ok: false, reason: "not_installed", bin };
    } else {
      const auth = await runProbe(bin, ["login", "status"]);
      if (auth.timedOut) {
        result = { ok: false, reason: "probe_timeout", bin };
      } else {
        const textOut = `${auth.stdout || ""}${auth.stderr || ""}`;
        const loggedIn = auth.status === 0 && !/not logged in|no credentials/i.test(textOut);
        result = {
          ok: loggedIn,
          reason: loggedIn ? null : "not_logged_in",
          bin,
          version: (v.stdout || "").trim(),
          authInfo: textOut.trim(),
        };
      }
    }
    probeCache = { at: Date.now(), result };
    return result;
  })();

  probePromise = current;
  try {
    return await current;
  } finally {
    if (probePromise === current) probePromise = null;
  }
}

export function checkCodex() {
  const bin = codexBinary();
  const v = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: CODEX_PROBE_TIMEOUT_MS });
  if (spawnTimedOut(v)) return { ok: false, reason: "probe_timeout", bin };
  if (v.error) return { ok: false, reason: "not_installed", bin };
  const auth = spawnSync(bin, ["login", "status"], { encoding: "utf8", timeout: CODEX_PROBE_TIMEOUT_MS });
  if (spawnTimedOut(auth)) return { ok: false, reason: "probe_timeout", bin };
  const textOut = `${auth.stdout || ""}${auth.stderr || ""}`;
  const loggedIn = auth.status === 0 && !/not logged in|no credentials/i.test(textOut);
  return {
    ok: loggedIn,
    reason: loggedIn ? null : "not_logged_in",
    bin,
    version: (v.stdout || "").trim(),
    authInfo: textOut.trim(),
  };
}

// ------------------------------------------------- определение доступных флагов

// Набор флагов codex exec менялся между версиями: --ask-for-approval в ряде
// сборок отсутствует и вызывает "unexpected argument". Поэтому не угадываем,
// а один раз спрашиваем сам бинарь и кэшируем ответ.
let capsCache = null;

export function capabilities({ force = false } = {}) {
  if (capsCache && !force) return capsCache;

  const cacheFile = path.join(path.dirname(dataDir()), "exec-caps.json");
  // Таймаут обязателен: вызов синхронный и идёт в главном процессе сервера,
  // поэтому зависший бинарь остановил бы обработку всех запросов разом.
  const ver = (
    spawnSync(codexBinary(), ["--version"], { encoding: "utf8", timeout: CODEX_PROBE_TIMEOUT_MS }).stdout || ""
  ).trim();

  if (!force) {
    try {
      const c = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
      if (c.version === ver) return (capsCache = c.caps);
    } catch {}
  }

  const help = spawnSync(codexBinary(), ["exec", "--help"], { encoding: "utf8", timeout: 15_000 });
  // Непустой вывод сам по себе ничего не доказывает: сломанный, зависший или
  // незнакомый бинарь пишет в stderr текст ошибки, и он так же непуст. Приняв
  // его за прочитанный help, мы получили бы caps сплошь false, buildArgs
  // выродился бы в ["exec", "-"], и Codex ушёл бы работать в каталог процесса
  // вместо каталога проекта. Пробой считается только штатно завершившийся help.
  const probeOk = !help.error && help.status === 0;
  const text = probeOk ? `${help.stdout || ""}${help.stderr || ""}` : "";
  const caps = {
    askForApproval: /--ask-for-approval/.test(text),
    sandbox: /--sandbox/.test(text),
    skipGitRepoCheck: /--skip-git-repo-check/.test(text),
    cd: /--cd\b/.test(text),
    image: /--image\b/.test(text),
    bypassSandbox: /--dangerously-bypass-approvals-and-sandbox/.test(text),
    json: /--json\b/.test(text),
    // help не прочитался — не выключаем базовые флаги, но и не включаем спорные
    probed: text.trim().length > 0,
  };
  if (!caps.probed) {
    caps.sandbox = true;
    caps.skipGitRepoCheck = true;
    caps.cd = true;
    caps.image = true;
  }

  // Неудачную пробу не запоминаем ни на диске, ни в памяти: иначе временно
  // сломанный codex зафиксировал бы урезанные возможности до конца жизни
  // процесса, а на диске — и после перезапуска. Следующий вызов попробует снова.
  if (!caps.probed) return caps;

  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true, mode: DIR_MODE });
    writeFileSecure(cacheFile, JSON.stringify({ version: ver, caps }, null, 2));
  } catch {}
  return (capsCache = caps);
}

// ------------------------------------------------------------- сборка команды

export function bypassSandboxEnabled() {
  const v = envClean("TANDEM_BYPASS_SANDBOX");
  return v === "true" || v === "1" || v === "yes";
}

/** Нативный backend включается только точным явным значением. */
export function reviewBackend() {
  return envClean("TANDEM_REVIEW_BACKEND") === "app-server" ? "app-server" : "exec";
}

const SANDBOX_BY_MODE = {
  collaborate: "read-only",
  ask: "read-only",
  review: "read-only",
  challenge: "read-only",
  chat: "read-only",
  delegate: "workspace-write",
};

export function buildArgs({ mode, model, effort, cwd, sandbox, images = [], resume = null, reasoningSummary = null, disabledMcpServers = null }) {
  const caps = capabilities();
  const args = ["exec"];
  // Продолжение разговора: `exec resume <uuid>` поднимает прежний тред.
  // Флага --cd у него нет, поэтому рабочий каталог задаёт сам процесс.
  const resuming = Boolean(resume);
  if (resuming) args.push("resume");
  // JSONL-поток событий: без него единственным сигналом о работе модели
  // остаётся таймаут. Ответ достаём из события agent_message.
  if (caps.json) args.push("--json");
  if (caps.skipGitRepoCheck) args.push("--skip-git-repo-check");

  // Аварийный обход: нужен, когда песочница Codex сломана рассинхроном версий.
  // Включается только явной настройкой — Codex тогда выполняет команды без
  // изоляции, и это осознанный размен, а не значение по умолчанию.
  if (bypassSandboxEnabled() && caps.bypassSandbox) {
    // Совместная сессия обязана оставаться read-only: обход здесь недопустим.
    if (Array.isArray(disabledMcpServers)) throw new Error("Collaboration requires the Codex sandbox; disable bypass_sandbox.");
    args.push("--dangerously-bypass-approvals-and-sandbox");
    if (cwd && caps.cd && !resuming) args.push("--cd", cwd);
    const mb = model || envClean("TANDEM_MODEL");
    if (mb) args.push("-m", mb);
    const eb = effort || envClean("TANDEM_EFFORT");
    if (eb) args.push("-c", `model_reasoning_effort="${eb}"`);
    const sb = reasoningSummary || envClean("TANDEM_REASONING_SUMMARY");
    if (sb) args.push("-c", `model_reasoning_summary="${sb}"`);
    if (caps.image) for (const img of images) args.push("--image", img);
    if (resuming) args.push(resume);
    args.push("-");
    return args;
  }

  const sb = sandbox || SANDBOX_BY_MODE[mode] || "read-only";
  if (resuming) {
    // У `exec resume` нет ни --sandbox, ни --ask-for-approval, ни --cd:
    // режим задаётся конфигом, а рабочий каталог — каталогом процесса.
    args.push("-c", `sandbox_mode="${sb}"`);
    if (sb === "workspace-write") args.push("-c", 'approval_policy="never"');
  } else {
    if (caps.sandbox) args.push("--sandbox", sb);
    // exec и так неинтерактивен; флаг добавляем только если он существует
    if (sb === "workspace-write" && caps.askForApproval) args.push("--ask-for-approval", "never");
    if (cwd && caps.cd) args.push("--cd", cwd);
  }

  const m = model || envClean("TANDEM_MODEL");
  if (m) args.push("-m", m);
  const e = effort || envClean("TANDEM_EFFORT");
  if (e) args.push("-c", `model_reasoning_effort="${e}"`);
  // Сводки размышлений: при auto Codex может не прислать ни одной, и лента
  // остаётся без самой содержательной части.
  const rs = reasoningSummary || envClean("TANDEM_REASONING_SUMMARY");
  if (rs) args.push("-c", `model_reasoning_summary="${rs}"`);
  if (caps.image) for (const img of images) args.push("--image", img);

  // Изоляция совместной сессии: пустая TOML-таблица mcp_servers не очищает
  // унаследованные серверы при слиянии слоёв, поэтому каждый выключается по имени.
  if (Array.isArray(disabledMcpServers)) {
    for (const flag of ["multi_agent", "plugins", "hooks", "apps"]) args.push("-c", `features.${flag}=false`);
    for (const name of disabledMcpServers) args.push("-c", `mcp_servers.${JSON.stringify(name)}.enabled=false`);
  }
  if (resuming) args.push(resume);
  args.push("-"); // промпт со stdin
  return args;
}

// ------------------------------------------------------------ сбор контекста

// Пороги сбора. Диф сверх порога не обрезается посреди hunk — вместо этого
// модель получает сводку и указание дочитать нужное самой: обрезанный патч
// выглядит целым и молча уводит ревью мимо половины изменений.
const DIFF_MAX_BYTES = 256 * 1024;
const DIFF_MAX_FILES = 60;
const DIFF_MAX_NAMES = 400;
const LOG_MAX_COMMITS = 200;
const UNTRACKED_FILE_MAX_BYTES = 24 * 1024;
const UNTRACKED_TOTAL_MAX_BYTES = 128 * 1024;
const UNTRACKED_MAX_FILES = 25;

// Новые файлы вкладываются содержимым, поэтому сюда не должны попадать
// секреты: ключи, окружение, учётные данные. Такие файлы только называются.
const SECRETISH =
  /(^|\/)(\.env(\.[^/]*)?|\.netrc|\.npmrc|\.pypirc|\.htpasswd|id_(rsa|dsa|ecdsa|ed25519)|credentials|[^/]*\.(pem|key|p12|pfx|jks|keystore|ppk))$/i;

// Диф всегда читается без внешнего diff-драйвера: чужой diff.external в
// конфиге репозитория иначе подменяет формат вывода. Подмодули — одной
// строкой: их полный диф втягивает чужой репозиторий целиком.
const DIFF_FLAGS = ["--no-ext-diff", "--submodule=short"];

function git(cwd, args, { maxBuffer = 64 * 1024 * 1024 } = {}) {
  return spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer });
}

/** Git обязан отработать: молчаливый пустой вывод неотличим от «изменений нет». */
function gitChecked(cwd, args) {
  const r = git(cwd, args);
  if (r.error) throw new Error(C().git_not_started(args[0], r.error.message || r.error));
  if (r.status !== 0) {
    throw new Error(C().git_failed(args.join(" "), r.status, (r.stderr || "").trim() || C().git_no_output));
  }
  return r.stdout || "";
}

/** Список путей из вывода с -z: имя файла может содержать перевод строки. */
const zSplit = (s) => String(s || "").split("\0").filter(Boolean);

/**
 * Проверка ссылки до её использования. Без --end-of-options значение вроде
 * "--upload-pack=..." разбирается как флаг; ^{commit} требует, чтобы ссылка
 * указывала на коммит, а не на дерево или тег-объект.
 */
function resolveCommit(cwd, ref) {
  const r = git(cwd, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]);
  const sha = (r.stdout || "").trim();
  if (r.status !== 0 || !sha) {
    throw new Error(C().ref_not_commit(JSON.stringify(ref)));
  }
  return sha;
}

/** Ветка по умолчанию: сравнивать не с чем, если её не нашли. */
function defaultBase(cwd) {
  const head = git(cwd, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  if (head.status === 0) {
    const name = (head.stdout || "").trim();
    if (name.startsWith("refs/remotes/")) return name.slice("refs/remotes/".length);
  }
  for (const c of ["main", "master", "trunk"]) {
    for (const ref of [`refs/heads/${c}`, `refs/remotes/origin/${c}`]) {
      if (git(cwd, ["show-ref", "--verify", "--quiet", ref]).status === 0) {
        return ref.startsWith("refs/remotes/") ? ref.slice("refs/remotes/".length) : c;
      }
    }
  }
  return null;
}

const isProbablyText = (buf) => {
  const head = buf.subarray(0, 8000);
  return !head.includes(0);
};

/** Новые файлы: содержимое, но не вслепую. */
function untrackedSection(cwd) {
  const files = zSplit(gitChecked(cwd, ["ls-files", "-z", "--others", "--exclude-standard"]));
  if (!files.length) return "";

  const parts = [];
  const listedOnly = [];
  let totalBytes = 0;

  for (const rel of files.slice(0, UNTRACKED_MAX_FILES)) {
    const abs = path.join(cwd, rel);
    let st;
    try {
      // lstat, не stat: разыменование симлинка вложило бы в ревью файл,
      // лежащий вне репозитория.
      st = fs.lstatSync(abs);
    } catch {
      listedOnly.push(C().untracked_unreadable(rel));
      continue;
    }
    if (st.isSymbolicLink()) {
      let target = "?";
      try {
        target = fs.readlinkSync(abs);
      } catch {}
      listedOnly.push(C().untracked_symlink(rel, target));
      continue;
    }
    if (st.isDirectory()) {
      listedOnly.push(C().untracked_directory(rel));
      continue;
    }
    if (!st.isFile()) {
      listedOnly.push(C().untracked_not_regular(rel));
      continue;
    }
    if (SECRETISH.test(rel.replace(/\\/g, "/"))) {
      listedOnly.push(C().untracked_secret(rel));
      continue;
    }
    if (st.size > UNTRACKED_FILE_MAX_BYTES) {
      listedOnly.push(C().untracked_too_big(rel, st.size, UNTRACKED_FILE_MAX_BYTES));
      continue;
    }
    if (totalBytes + st.size > UNTRACKED_TOTAL_MAX_BYTES) {
      listedOnly.push(C().untracked_over_total(rel));
      continue;
    }

    // Читается тот же объект, который проверен: между lstat и чтением по имени
    // файл успевает стать симлинком наружу. Дескриптор открывается без
    // разыменования, и проверки повторяются уже по нему.
    let buf;
    let fd;
    try {
      fd = fs.openSync(abs, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const fst = fs.fstatSync(fd);
      if (!fst.isFile() || fst.size > UNTRACKED_FILE_MAX_BYTES) {
        listedOnly.push(C().untracked_unreadable(rel));
        continue;
      }
      buf = fs.readFileSync(fd);
    } catch {
      listedOnly.push(C().untracked_unreadable(rel));
      continue;
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {}
      }
    }
    if (!isProbablyText(buf)) {
      listedOnly.push(C().untracked_binary(rel));
      continue;
    }
    totalBytes += buf.length;
    parts.push(`### ${rel}\n\`\`\`\n${buf.toString("utf8").trimEnd()}\n\`\`\``);
  }

  if (files.length > UNTRACKED_MAX_FILES) {
    listedOnly.push(C().untracked_more(files.length - UNTRACKED_MAX_FILES, UNTRACKED_MAX_FILES));
  }
  if (listedOnly.length) {
    parts.push(`### ${C().untracked_listed_only}\n${listedOnly.map((l) => `- ${l}`).join("\n")}`);
  }
  return parts.join("\n\n");
}

/**
 * Диф заданного диапазона либо сводка с указанием дочитать самому.
 * Размер сначала измеряется дешёвым --numstat: полный диф в память не
 * загружается, если заведомо велик.
 */
function diffOrSummary(cwd, range) {
  const rangeArgs = range ? [range] : [];
  // Секреты вырезаются и из отслеживаемых файлов тоже. Прежде фильтр стоял
  // только на новых файлах, поэтому изменение уже добавленного в репозиторий
  // .env или ключа уходило модели целиком, строка за строкой.
  const secret = zSplit(gitChecked(cwd, ["diff", ...DIFF_FLAGS, "--name-only", "-z", ...rangeArgs])).filter((p) =>
    SECRETISH.test(p.replace(/\\/g, "/"))
  );
  const scope = secret.length
    ? [...rangeArgs, "--", ".", ...secret.map((p) => `:(exclude,literal)${p}`)]
    : rangeArgs;
  const hidden = secret.length ? `\n\n${C().diff_secrets_hidden(secret.join("\n"))}` : "";

  const numstat = gitChecked(cwd, ["diff", ...DIFF_FLAGS, "--numstat", ...scope]);
  const fileCount = numstat.split("\n").filter((l) => l.trim()).length;
  if (!fileCount) return { text: (secret.length ? C().no_changes + hidden : C().no_changes), inline: true, fileCount: 0 };

  if (fileCount <= DIFF_MAX_FILES) {
    const r = git(cwd, ["diff", ...DIFF_FLAGS, ...scope], { maxBuffer: DIFF_MAX_BYTES });
    // ENOBUFS здесь означает «не поместилось»: stderr у git diff пуст, а
    // предел выставлен именно под ожидаемый объём патча.
    if (!r.error && r.status === 0) return { text: r.stdout + hidden, inline: true, fileCount };
    if (r.error && r.error.code !== "ENOBUFS") {
      throw new Error(C().git_diff_failed(r.error.message || r.error));
    }
    if (!r.error && r.status !== 0) {
      throw new Error(C().git_failed("diff", r.status, (r.stderr || "").trim() || C().git_no_output));
    }
  }

  const shortstat = gitChecked(cwd, ["diff", ...DIFF_FLAGS, "--shortstat", ...scope]).trim();
  // Сводка тоже обязана иметь верхнюю границу: тысяча изменённых файлов даёт
  // список имён на сотни килобайт, то есть ровно то, от чего сводка спасала.
  const all = zSplit(gitChecked(cwd, ["diff", ...DIFF_FLAGS, "--name-status", "-z", ...scope]));
  const names = all.slice(0, DIFF_MAX_NAMES);
  if (all.length > names.length) names.push(C().names_more(all.length - names.length));
  return {
    inline: false,
    fileCount,
    text: C().patch_too_big(range || "", shortstat || C().none, fileCount, names.join("\n")) + hidden,
  };
}

const section = (title, body) => `## ${title}\n\n${String(body || "").trim() || C().empty_section}\n`;

/**
 * Контекст для ревью.
 *
 * Раньше сбор был устроен так, что две его ветки не пересекались: с base
 * ревьюились только коммиты, без base — только рабочее дерево. На ветке с
 * коммитами и незакоммиченными правками любой из двух вызовов молча показывал
 * половину картины. Теперь при base собираются обе части, разделённые явно:
 * что уйдёт в PR и что ещё нет — разные вещи, и модель должна их различать.
 */
export function collectDiff(cwd, base) {
  if (git(cwd, ["rev-parse", "--show-toplevel"]).status !== 0) {
    throw new Error(C().not_a_repo);
  }

  const dirty = () => {
    const staged = zSplit(gitChecked(cwd, ["diff", "--cached", "--name-only", "-z"]));
    const unstaged = zSplit(gitChecked(cwd, ["diff", "--name-only", "-z"]));
    const untracked = zSplit(gitChecked(cwd, ["ls-files", "-z", "--others", "--exclude-standard"]));
    return staged.length + unstaged.length + untracked.length > 0;
  };

  const workingTree = () => {
    // HEAD, а не пустой диапазон: без него в патч попадает только unstaged,
    // а проиндексованное — то, что человек уже готовит к коммиту, — исчезает.
    const d = diffOrSummary(cwd, "HEAD");
    const untracked = untrackedSection(cwd);
    return section(C().sec_not_committed, d.text) + (untracked ? `\n${section(C().sec_new_files, untracked)}` : "");
  };

  // Без base и с грязным деревом ревьюится то, над чем идёт работа.
  // Дерево чистое — сравнивать не с чем, поэтому берём ветку по умолчанию:
  // иначе команда возвращала пустоту и выглядела сломанной.
  let baseRef = base || null;
  let isDirty = null;
  if (!baseRef) {
    isDirty = dirty();
    if (isDirty) return `${section(C().sec_reviewing, C().working_tree_only)}\n${workingTree()}`.trim();
    baseRef = defaultBase(cwd);
    if (!baseRef) {
      throw new Error(C().clean_tree_no_base);
    }
  }

  const baseSha = resolveCommit(cwd, baseRef);
  // Отсутствие общего предка — не мелочь: сравнение с самой базой вместо точки
  // расхождения показывает совсем другой набор изменений, и молча подменять
  // одно другим нельзя.
  const mb = git(cwd, ["merge-base", baseSha, "HEAD"]);
  if (mb.error) throw new Error(C().git_not_started("merge-base", mb.error.message || mb.error));
  const mergeBase = (mb.stdout || "").trim();
  if (!mergeBase) throw new Error(C().no_merge_base(baseRef));
  const branch = (git(cwd, ["branch", "--show-current"]).stdout || "").trim() || "HEAD";
  const logAll = gitChecked(cwd, [
    "log",
    "--oneline",
    "--no-decorate",
    `--max-count=${LOG_MAX_COMMITS + 1}`,
    `${mergeBase}..HEAD`,
  ])
    .trim()
    .split("\n")
    .filter(Boolean);
  const log = (logAll.length > LOG_MAX_COMMITS ? [...logAll.slice(0, LOG_MAX_COMMITS), C().commits_more] : logAll).join(
    "\n"
  );
  const committed = diffOrSummary(cwd, `${mergeBase}..HEAD`);

  const head = C().branch_head(branch, baseRef, mergeBase.slice(0, 12));

  const parts = [
    section(C().sec_reviewing, head),
    section(C().sec_branch_commits, log || C().no_commits),
    section(C().sec_committed, committed.text),
  ];
  // Состояние дерева уже выяснено выше, если база не была задана явно.
  if (isDirty === null) isDirty = dirty();
  parts.push(isDirty ? workingTree() : section(C().sec_not_committed, C().clean_worktree));
  return parts.join("\n").trim();
}

// --------------------------------------------------------------- промпты

export function buildPrompt({ mode, task, focus, question, context, cwd, base, message, resume }) {
  if (mode === "chat") return resume ? String(message || "") : prompt("chat", message, context);
  if (mode === "delegate") return prompt("delegate", task);
  if (mode === "ask") return prompt("ask", question, context);
  const diff = collectDiff(cwd, base);
  return prompt(mode === "challenge" ? "challenge" : "review", diff, focus);
}

// ------------------------------------------------- разбор ошибок Codex

// Строки, которые Codex пишет всегда и которые к делу не относятся.
// Самая частая — рассинхрон формата его собственного кэша моделей; на работу
// не влияет, но забивает сообщение об ошибке и пугает пользователя.
const NOISE = [
  /failed to load models cache/i,
  /codex_models_manager::cache/i,
  /^\s*$/,
];

export function denoise(text) {
  return String(text || "")
    .split("\n")
    .filter((l) => !NOISE.some((re) => re.test(l)))
    .join("\n")
    .trim();
}

/**
 * Переводит типовые отказы Codex в понятное объяснение с готовым действием.
 * Без этого пользователь видит кусок JSON от API и стектрейс Rust.
 */
export function explainCodexFailure(stderr, stdout = "") {
  const all = `${stderr}\n${stdout}`;

  // Уровень reasoning, не поддерживаемый моделью
  const eff = /'([^']+)' is not supported with the '([^']+)' model/i.exec(all);
  if (eff) {
    const supported = [...all.matchAll(/'([a-z]+)'/gi)]
      .map((m) => m[1])
      .filter((v) => ["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(v) && v !== eff[1]);
    return C().effort_unsupported(eff[2], eff[1], supported.length ? [...new Set(supported)].join(", ") : "");
  }

  // Сбой песочницы Windows. Наружу выходит как "mcp ... (failed)" или
  // "user cancelled MCP tool call" — читается как отказ пользователя или
  // мёртвый сервер, хотя причина в рассинхроне версий установки Codex.
  const helper = /orchestrator_helper_launch_failed|helper=([\w.-]*sandbox[\w.-]*)|codex-windows-sandbox-setup/i.exec(all);
  if (helper || (/windows sandbox/i.test(all) && /program not found|failed to launch/i.test(all))) {
    return C().sandbox_windows(helper?.[1] ? ` (${helper[1]})` : "");
  }

  if (/user cancelled MCP tool call|tool call was cancelled/i.test(all) && !/interrupt/i.test(all)) {
    return C().mcp_cancelled;
  }

  if (/not logged in|no credentials|unauthorized|401/i.test(all)) return C().not_authorized;
  if (/rate.?limit|quota|429/i.test(all)) return C().quota;
  if (/unexpected argument\s+'?(--[\w-]+)/i.test(all)) {
    return C().unknown_flag(/unexpected argument\s+'?(--[\w-]+)/i.exec(all)[1]);
  }
  return null;
}

// ------------------------------------------------------------------- задачи

const TERMINAL = new Set(["done", "failed", "cancelled", "timeout", "unknown"]);

const JOB_TIMEOUT_DEFAULT_MIN = 30;
const JOB_TIMEOUT_MAX_MIN = 480;

/**
 * Таймаут задачи. Значение приходит из настройки, поэтому проверяется:
 * отрицательное отключало таймер воркера и одновременно срабатывало в
 * реконсиляции, а Infinity непригоден для setTimeout.
 */
export function jobTimeoutMs() {
  const n = Number(envClean("TANDEM_JOB_TIMEOUT_MIN"));
  const min = Number.isFinite(n) && n >= 1 ? Math.min(n, JOB_TIMEOUT_MAX_MIN) : JOB_TIMEOUT_DEFAULT_MIN;
  return min * 60_000;
}

/**
 * Запускает задачу отдельным процессом-воркером (scripts/job-worker.mjs).
 *
 * Раньше здесь был `/bin/sh` с редиректами: на Windows такого бинаря нет, и
 * задача умирала до первой строки вывода, оставляя статус unknown. Воркер на
 * Node переносим, сам ставит метки времени событиям, сам пишет код возврата и
 * сам убивает дерево процессов по таймауту.
 *
 * Код возврата в отдельном файле остаётся единственным признаком завершения:
 * обработчик exit в родителе не переживает перезапуск MCP-сервера и создавал
 * гонку с cancelJob().
 */
// Замок на запуск. Подсчёт живых задач и старт нового воркера обязаны быть
// одной операцией: двум экземплярам MCP-сервера иначе видно одно и то же
// число задач, и предел они пробивают одновременно.
const START_LOCK_STALE_MS = 30_000;
const START_LOCK_WAIT_MS = 500;
const START_LOCK_RETRY_MS = 25;

/** Предел живых задач. Ноль — без предела. */
export function maxParallelJobs() {
  const raw = envClean("TANDEM_MAX_PARALLEL_JOBS");
  if (raw === undefined) return 4;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 4;
  return Math.floor(n);
}

// Ожидание без прокрутки цикла: startJob синхронный, а замок держат
// миллисекунды. Иначе пришлось бы жечь процессор в busy-loop.
const sleepSync = (ms) => {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {}
};

function withStartLock(fn) {
  const lock = path.join(dataDir(), "start.lock");
  const deadline = Date.now() + START_LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      let age = Infinity;
      try {
        age = Date.now() - fs.statSync(lock).mtimeMs;
      } catch {}
      if (age > START_LOCK_STALE_MS) {
        // Снятие через переименование, а не через rmdir: удалить и тут же
        // создать заново — две операции, между которыми замок успевает взять
        // другой процесс, и следующий rmdir снимает уже чужой живой замок.
        // Переименовать существующий каталог удаётся ровно одному.
        try {
          fs.renameSync(lock, `${lock}.stale.${process.pid}.${Date.now()}`);
        } catch {}
        try {
          for (const name of fs.readdirSync(path.dirname(lock))) {
            if (name.startsWith("start.lock.stale.")) fs.rmSync(path.join(path.dirname(lock), name), { recursive: true, force: true });
          }
        } catch {}
        continue;
      }
      if (Date.now() >= deadline) {
        const err = new Error(C().start_lock_busy);
        err.busy = true;
        throw err;
      }
      sleepSync(START_LOCK_RETRY_MS);
    }
  }
  try {
    return fn();
  } finally {
    try {
      fs.rmdirSync(lock);
    } catch {}
  }
}

/**
 * Живые задачи по всему хранилищу.
 *
 * Предел общий, а не по репозиторию: квота ChatGPT, память и процессорное
 * время машины — один ресурс на все проекты сразу.
 */
export function liveJobs() {
  let names = [];
  try {
    names = fs.readdirSync(dataDir());
  } catch {
    return [];
  }
  const staleMs = jobTimeoutMs() * 2;
  return names
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""))
    .filter(isValidJobId)
    .map(readJob)
    .filter(Boolean)
    .map(reconcile)
    .filter((j) => {
      // Считается процесс, а не статус. Отмена помечает задачу терминальной
      // сразу, хотя воркер ещё жив и продолжает тратить квоту: если верить
      // статусу, предел параллельных задач обходится одним codex_cancel.
      if (readExitCode(j.id) !== null) return false;
      if (!workerAlive(j)) return false;
      // Метки жизни нет — формат старый, и единственная защита от чужого pid
      // это возраст: дольше двойного таймаута задача уже была бы убита.
      if (heartbeat(j.id).present) return true;
      const age = Date.now() - new Date(j.startedAt).getTime();
      return !(Number.isFinite(age) && age > staleMs);
    });
}

export function startJob(opts) {
  return withStartLock(() => {
    const limit = maxParallelJobs();
    if (limit > 0) {
      const live = liveJobs();
      if (live.length >= limit) {
        const err = new Error(
          C().limit_reached(
            live.length,
            limit,
            live.map((j) => `  · ${j.id} — ${j.mode}${j.label ? `: ${j.label.slice(0, 60)}` : ""}`).join("\n")
          )
        );
        err.busy = true;
        throw err;
      }
    }
    return startJobUnlocked(opts);
  });
}

function startJobUnlocked(opts) {
  const id = `job-${crypto.randomBytes(4).toString("hex")}`;
  const cwd = opts.cwd || process.cwd();
  // Нативному ревью промпт не нужен: цель протокола структурная. Он собирается
  // только как материал для exec-fallback, поэтому невозможность его собрать
  // запрещает fallback, но не сам запуск.
  const allowFallback = opts.allowFallback !== false;
  const prompt = opts.prompt || (allowFallback ? buildPrompt({ ...opts, cwd }) : "");
  const backend = opts.mode === "review" ? opts.backend || reviewBackend() : "exec";

  const promptFile = jobPath(id, "prompt");
  const outFile = jobPath(id, "out");
  const codeFile = jobPath(id, "code");
  const noteFile = jobPath(id, "note");
  const cancelFile = jobPath(id, "cancel");
  const aliveFile = jobPath(id, "alive");
  const specFile = jobPath(id, "spec");
  writeFileSecure(promptFile, prompt);

  const args = buildArgs({ ...opts, cwd });
  writeFileSecure(
    specFile,
    JSON.stringify({
      bin: codexBinary(),
      args,
      promptFile,
      outFile,
      codeFile,
      noteFile,
      cancelFile,
      aliveFile,
      heartbeatMs: HEARTBEAT_INTERVAL_MS,
      cwd,
      backend,
      allowFallback,
      reviewTarget: opts.reviewTarget || null,
      appServerCommand: opts.appServerCommand || null,
      model: opts.model || envClean("TANDEM_MODEL") || null,
      effort: opts.effort || envClean("TANDEM_EFFORT") || null,
      reasoningSummary: opts.reasoningSummary || envClean("TANDEM_REASONING_SUMMARY") || null,
      timeoutMs: Number(opts.jobTimeoutMs) || jobTimeoutMs(),
      collaborationChild: opts.collaborationChild === true,
    })
  );

  // Запись предшествует запуску. Обратный порядок оставлял бы процесс Codex,
  // о котором никто не знает: сбой записи между spawn и writeJob делал его
  // невидимым и для учёта, и для отмены.
  const record = {
    id,
    pid: null,
    mode: opts.mode,
    backend,
    model: opts.model || envClean("TANDEM_MODEL") || null,
    effort: opts.effort || envClean("TANDEM_EFFORT") || null,
    label: String(opts.task || opts.focus || opts.question || opts.message || opts.mode || "").slice(0, 120),
    chat: opts.chat || null,
    resumedFrom: opts.resume || null,
    cwd,
    repo: repoKey(cwd),
    status: "running",
    exitCode: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  writeJob(record);

  const worker = path.join(import.meta.dirname, "job-worker.mjs");
  const child = spawn(process.execPath, [worker, specFile], {
    cwd,
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
    windowsHide: true,
  });
  child.unref();

  let job;
  try {
    job = writeJob({ ...record, pid: child.pid ?? null });
  } catch (e) {
    // Процесс уже идёт, а записать его pid не удалось: оставить его работать
    // значит потерять управление им навсегда.
    killTree(child.pid);
    throw e;
  }

  // Отказ запуска самого воркера: без этого задача осталась бы «running»
  // навсегда, а причина — только в stderr, которого никто не читает.
  child.on("error", (e) => {
    try {
      fs.appendFileSync(
        outFile,
        JSON.stringify({ type: "turn.failed", error: { message: C().worker_spawn_failed(e?.message || e) } }) + "\n"
      );
      writeFileSecure(codeFile, "127");
      writeFileSecure(noteFile, "spawn_failed");
    } catch {}
  });

  return job;
}

/**
 * Признак жизни воркера. Одного pid мало: номера переиспользуются, и тогда
 * задача считалась бы живой по чужому процессу, а страховочный killTree убивал
 * бы его. Воркер обновляет метку каждые несколько секунд, поэтому свежая метка
 * означает именно наш процесс.
 *
 * Журналы прежних версий метки не имеют: для них остаётся прежнее правило по
 * pid и возрасту, иначе задачи, пережившие обновление, разом стали бы мёртвыми.
 */
export const HEARTBEAT_INTERVAL_MS = 5_000;
const HEARTBEAT_STALE_MS = 30_000;
const STARTUP_GRACE_MS = 15_000;

function heartbeat(id) {
  try {
    return { present: true, age: Date.now() - fs.statSync(jobPath(id, "alive")).mtimeMs };
  } catch {
    return { present: false, age: Infinity };
  }
}

/** Воркер этой задачи точно жив — значит процесс наш и его можно трогать. */
function workerAlive(job) {
  // Первые секунды метки ещё нет: воркер только запускается. Без отсрочки
  // задача объявлялась бы мёртвой прямо в момент старта.
  const age = Date.now() - new Date(job.startedAt).getTime();
  if (Number.isFinite(age) && age >= 0 && age < STARTUP_GRACE_MS) return true;
  const hb = heartbeat(job.id);
  if (hb.present) return hb.age < HEARTBEAT_STALE_MS;
  // Старый формат: другого признака, кроме pid, нет.
  return alive(job.pid);
}

function readNote(id) {
  try {
    return fs.readFileSync(jobPath(id, "note"), "utf8").trim() || null;
  } catch {
    return null;
  }
}

function readExitCode(id) {
  try {
    const raw = fs.readFileSync(jobPath(id, "code"), "utf8").trim();
    if (!/^-?\d+$/.test(raw)) return null;
    return Number(raw);
  } catch {
    return null;
  }
}

// Пометка воркера о причине завершения → статус и человеческое объяснение.
const NOTE_STATUS = {
  timeout: ["timeout", "note_timeout"],
  cancelled: ["cancelled", "note_cancelled"],
  spawn_failed: ["failed", "note_spawn_failed"],
};

/** Приводит статус в соответствие с реальностью. Терминальные не трогает. */
function reconcile(job) {
  if (!job?.id || TERMINAL.has(job.status)) return job;

  const code = readExitCode(job.id);
  if (code !== null) {
    const mapped = NOTE_STATUS[readNote(job.id)];
    job.status = mapped ? mapped[0] : code === 0 ? "done" : "failed";
    if (mapped) job.note = C()[mapped[1]]; // в таблице лежит ключ, не текст
    job.exitCode = code;
    job.finishedAt = job.finishedAt || new Date().toISOString();
    return writeJob(job);
  }

  if (!workerAlive(job)) {
    // Процесса нет, кода возврата нет — считать успехом нельзя.
    job.status = "unknown";
    job.note = C().note_vanished;
    job.finishedAt = job.finishedAt || new Date().toISOString();
    return writeJob(job);
  }

  // Страховка на случай, если воркер умер, не успев отработать свой таймер.
  // Убивать позволено только при подтверждённой метке жизни: без неё pid мог
  // быть переиспользован, и под ним работает чужой процесс.
  const limit = jobTimeoutMs();
  if (Date.now() - new Date(job.startedAt).getTime() > limit) {
    if (alive(job.pid)) killTree(job.pid);
    job.status = "timeout";
    job.finishedAt = new Date().toISOString();
    return writeJob(job);
  }
  return job;
}

// Хранилище задач ничем не ограничено, а в нём лежат промпты с полными дифами
// и журналы событий. Уборка идёт только по завершённым и достаточно старым
// задачам: работающую или недавнюю трогать нельзя — за ней ещё придут.
const RETENTION_MS = 7 * 24 * 60 * 60_000;
const RETENTION_KEEP = 200;
const JOB_EXTS = ["json", "out", "prompt", "spec", "code", "note", "cancel", "alive"];
let sweptAt = 0;

function sweepJobs(jobs) {
  if (Date.now() - sweptAt < 60 * 60_000) return;
  sweptAt = Date.now();
  const stale = jobs.filter((j) => {
    if (!TERMINAL.has(j.status)) return false;
    const at = new Date(j.finishedAt || j.startedAt).getTime();
    return Number.isFinite(at) && Date.now() - at > RETENTION_MS;
  });
  const extra = jobs.filter((j) => TERMINAL.has(j.status)).slice(RETENTION_KEEP);
  for (const j of new Set([...stale, ...extra])) {
    for (const ext of JOB_EXTS) {
      try {
        fs.rmSync(jobPath(j.id, ext), { force: true });
      } catch {}
    }
  }
}

export function listJobs(cwd) {
  const dir = dataDir();
  const repo = repoKey(cwd || process.cwd());
  const all = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""))
    .filter(isValidJobId)
    .map(readJob)
    .filter(Boolean)
    .map(reconcile)
    .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
  sweepJobs(all);
  return all.filter((j) => !repo || j.repo === repo);
}

export function latestJob(cwd) {
  return listJobs(cwd)[0] || null;
}

export function resolveJob(id, cwd) {
  if (id === undefined || id === null || id === "") return latestJob(cwd);
  if (!isValidJobId(id)) return null;
  const j = readJob(id);
  return j ? reconcile(j) : null;
}

export function jobOutput(id, { tail = 0 } = {}) {
  let textOut = "";
  try {
    textOut = fs.readFileSync(jobPath(id, "out"), "utf8");
  } catch {
    return "";
  }
  return tail > 0 ? textOut.split("\n").slice(-tail).join("\n") : textOut;
}

/**
 * Лента прогресса фоновой задачи: что модель делала и делает сейчас.
 * Читается из того же лога, куда пишется JSONL-поток событий.
 */
export function jobProgress(id, { limit = 12 } = {}) {
  const raw = jobOutput(id);
  const events = parseStream(raw);
  return {
    trail: progressTrail(events, { limit }),
    finished: isFinished(events),
    hasEvents: events.length > 0,
  };
}

/** Итоговый ответ фоновой задачи, извлечённый из потока событий. */
export function jobAnswer(id) {
  return extractOutput(jobOutput(id)).text;
}

/** id треда Codex для этой задачи — чтобы продолжить разговор. */
export function jobThreadId(id) {
  return threadIdOf(jobOutput(id));
}

export function cancelJob(id) {
  if (!isValidJobId(id)) return { ok: false, error: C().bad_job_id(id) };
  const job = readJob(id);
  if (!job) return { ok: false, error: C().job_not_found(id) };
  if (TERMINAL.has(job.status)) return { ok: true, job, note: C().already_status(job.status) };

  if (job.backend === "app-server") {
    // Воркер владеет stdio-соединением и только он может послать
    // turn/interrupt. Файл переживает перезапуск MCP-сервера.
    writeFileSecure(jobPath(id, "cancel"), new Date().toISOString());
  } else {
    killTree(job.pid);
  }
  job.status = "cancelled";
  job.finishedAt = new Date().toISOString();
  writeJob(job); // cancelled терминален — reconcile его больше не тронет
  return { ok: true, job };
}

// ------------------------------------------------------- наблюдение за задачей

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Читает журнал задачи по мере появления строк и отдаёт события наружу.
 *
 * Это замена прежнему spawnSync: он блокировал event loop MCP-сервера на всё
 * время работы Codex, из-за чего сервер не отвечал на ping и клиент рвал
 * соединение с "Connection closed". Здесь ожидание асинхронное, а работу ведёт
 * отдельный процесс — поэтому истечение waitMs не отменяет и не перезапускает
 * задачу, она просто продолжает идти в фоне.
 */
export async function followJob(id, { timeoutMs = 0, onEvent, signal, pollMs = 200 } = {}) {
  const file = jobPath(id, "out");
  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : Infinity;
  let offset = 0;
  let tail = "";
  const events = [];
  // Границы чтений произвольны относительно многобайтных символов: обычный
  // toString на стыке превращал бы кириллицу в замену. Декодер удерживает
  // незавершённую последовательность до следующего куска.
  const decoder = new StringDecoder("utf8");

  const drain = () => {
    let chunk = "";
    try {
      const fd = fs.openSync(file, "r");
      try {
        const size = fs.fstatSync(fd).size;
        if (size > offset) {
          const buf = Buffer.alloc(size - offset);
          fs.readSync(fd, buf, 0, buf.length, offset);
          offset = size;
          chunk = decoder.write(buf);
        }
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return; // файла ещё нет — воркер не успел создать
    }
    tail += chunk;
    const lines = tail.split("\n");
    tail = lines.pop() ?? ""; // последняя строка может быть недописана
    for (const line of lines) {
      const e = parseLine(line);
      if (!e) continue;
      events.push(e);
      if (onEvent) {
        try {
          onEvent(e);
        } catch {}
      }
    }
  };

  for (;;) {
    drain();
    if (readExitCode(id) !== null) {
      drain(); // последние строки могли лечь между чтением и завершением
      return { finished: true, timedOut: false, aborted: false, events };
    }
    if (signal?.aborted) return { finished: false, timedOut: false, aborted: true, events };
    if (Date.now() >= deadline) return { finished: false, timedOut: true, aborted: false, events };
    await sleep(pollMs);
  }
}

/** Результат завершённой задачи в том же виде, что и раньше у runSync. */
export function jobResult(id) {
  const job = resolveJob(id);
  if (!job) return { ok: false, error: C().job_not_found_plain };

  const raw = jobOutput(id);
  const parsed = extractOutput(raw);
  const out = denoise(parsed.text);
  const trail = progressTrail(parsed.events, { limit: 8 });
  // Диагностика Codex лежит в stderr. Воркер помечает происхождение строк,
  // поэтому её больше не приходится угадывать по «строка начинается с {»:
  // на старом Codex без --json такой признак не работал вовсе и весь вывод
  // одновременно считался и ответом, и шумом. Журналы прежних версий читаются
  // по старому правилу — иначе фоновые задачи, пережившие обновление, ослепнут.
  const noise = denoise(
    hasStreamTags(parsed.events)
      ? streamText(parsed.events, "stderr")
      : raw
          .split("\n")
          .filter((l) => !l.trim().startsWith("{"))
          .join("\n")
  );

  if (job.status === "done") return { ok: true, job, output: out, stderr: noise, trail, usage: usageOf(parsed.events) };
  if (job.status === "running") return { ok: false, job, running: true, trail, error: C().job_still_running };

  // Ненулевой код — всегда ошибка, даже если что-то успело напечататься:
  // частичный отчёт, выданный за успех, опаснее пустого отказа.
  const reason = job.note || explainCodexFailure(noise, out);
  return {
    ok: false,
    job,
    exitCode: job.exitCode,
    partialOutput: out || null,
    reason,
    trail,
    error:
      (reason ? `${reason}\n\n` : "") +
      C().codex_exit(job.status, job.exitCode) +
      (noise ? `\n${noise.slice(0, 800)}` : "") +
      (trail.length ? `\n\n${C().trail_label}\n${trail.map((l) => `  · ${l}`).join("\n")}` : "") +
      (out && !reason ? `\n\n${C().partial_output(out.slice(0, 800))}` : ""),
  };
}

/**
 * Полный цикл: запустить задачу и подождать её ответ, отдавая события по ходу.
 * Не уложились в waitMs — задача остаётся жить, возвращается её id.
 */
export async function runJob(opts, { waitMs = 120_000, onEvent, signal } = {}) {
  const job = startJob(opts);
  const f = await followJob(job.id, { timeoutMs: waitMs, onEvent, signal });
  if (f.aborted) {
    cancelJob(job.id);
    return { ok: false, aborted: true, job, trail: progressTrail(f.events, { limit: 8 }) };
  }
  if (!f.finished) {
    return { ok: false, timedOut: true, job, trail: progressTrail(f.events, { limit: 8 }) };
  }
  const r = jobResult(job.id);
  return { ...r, job: r.job || job }; // статус берём после reconcile, а не из момента запуска
}

/** Нормализованная лента задачи — для показа хода работы. */
export function jobTrail(id, { limit = 40 } = {}) {
  return normalizeStream(jobOutput(id)).slice(-limit);
}

export function humanAge(iso) {
  const u = uiText();
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return u.age_seconds(s);
  if (s < 3600) return u.age_minutes(Math.round(s / 60));
  return u.age_hours((s / 3600).toFixed(1));
}
