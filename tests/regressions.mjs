#!/usr/bin/env node
// tests/regressions.mjs — по одному тесту на каждый дефект из ревью.
// Запуск: node tests/regressions.mjs
// Зависимостей нет; настоящие codex/claude не нужны — используются заглушки.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, spawn } from "node:child_process";
import readline from "node:readline";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
// На Windows абсолютный путь не является валидным URL для ESM-загрузчика.
const ROOT_URL = pathToFileURL(ROOT).href;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "tandem-test-"));
const results = [];

function t(name, fn) {
  return (async () => {
    try {
      await fn();
      results.push({ name, ok: true });
    } catch (e) {
      results.push({ name, ok: false, error: e.message || String(e) });
    }
  })();
}

// Заглушка codex — это shebang-скрипт: Windows такой файл запустить не может,
// а права 0600 и кавычки в имени файла там тоже не проверяются. Такие тесты
// честно помечаются пропущенными, а не выдаются за пройденные.
const WIN = process.platform === "win32";
function tExec(name, fn) {
  if (WIN) {
    results.push({ name, ok: true, skipped: true });
    return Promise.resolve();
  }
  return t(name, fn);
}

const fresh = (n) => {
  const d = path.join(TMP, n);
  fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(d, { recursive: true });
  return d;
};

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

/** Заглушка codex: поведение задаётся переменной FAKE. */
function fakeCodex(dir) {
  const p = path.join(dir, "codex");
  fs.writeFileSync(
    p,
    `#!/usr/bin/env node
const fs=require("fs"),path=require("path");
const a=process.argv.slice(2);
if(a[0]==="--version"){console.log("codex 0.0.0-fake");process.exit(0)}
if(a[0]==="login"){console.log("Logged in as fake@example.com");process.exit(0)}
if(a[0]==="exec"&&a[1]==="--help"){console.log(process.env.FAKE_HELP||"Usage: codex exec\\n  --sandbox <mode>\\n  --skip-git-repo-check\\n  --cd <dir>\\n  --image <file>");process.exit(0)}
if(a[0]==="debug"&&a[1]==="models"){console.log(process.env.FAKE_MODELS||JSON.stringify({models:[{id:"m-one",display_name:"One"}]}));process.exit(0)}
if(a[0]==="exec"){
  fs.writeFileSync(process.env.FAKE_ARGV_OUT||"/dev/null",JSON.stringify(a));
  let prompt=""; try{prompt=fs.readFileSync(0,"utf8")}catch{}
  const mode=process.env.FAKE||"ok";
  if(mode==="exit7"){console.log("PARTIAL OUTPUT");console.error("fatal detail");process.exit(7)}
  if(mode==="slow"){setTimeout(()=>process.exit(0),60000);return}
  if(mode==="notimage"){const f=path.join(process.env.FAKE_STRAY,"secret.txt");fs.writeFileSync(f,"top secret");console.log("SAVED: "+f);process.exit(0)}
  if(mode==="outside"){const f=path.join(require("os").tmpdir(),"outside-"+Date.now()+".png");fs.writeFileSync(f,Buffer.from(${JSON.stringify(PNG.toString("base64"))},"base64"));console.log("SAVED: "+f);process.exit(0)}
  const m=/^\\s+(\\/\\S+\\.png)$/m.exec(prompt);
  if(m){fs.mkdirSync(path.dirname(m[1]),{recursive:true});fs.writeFileSync(m[1],Buffer.from(${JSON.stringify(PNG.toString("base64"))},"base64"));console.log("SAVED: "+m[1])}
  console.log("done");process.exit(0)
}
process.exit(1);
`,
    { mode: 0o755 }
  );
  return p;
}

/** Заглушка app-server: настоящий Codex и сеть тестам не нужны. */
function fakeAppServer(dir, mode = "complete") {
  const p = path.join(dir, `fake-app-server-${mode}.mjs`);
  fs.writeFileSync(
    p,
    `import fs from "node:fs";
import readline from "node:readline";
const mode = ${JSON.stringify(mode)};
const log = process.env.FAKE_APP_LOG;
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const record = (message) => { if (log) fs.appendFileSync(log, JSON.stringify(message) + "\\n"); };
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  record(message);
  if (message.method === "initialize") {
    if (mode === "collision") {
      send({ id: message.id, method: "approval/request", params: { reason: "test" } });
      return setTimeout(() => send({ id: message.id, result: { userAgent: "fake", codexHome: "/tmp", platformFamily: "unix", platformOs: "linux" } }), 20);
    }
    send({ id: message.id, result: { userAgent: "fake", codexHome: "/tmp", platformFamily: "unix", platformOs: "linux" } });
    return;
  }
  if (message.method === "initialized") return;
  if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: { id: "thread-1" } } });
    return;
  }
  if (message.method === "review/start") {
    if (mode === "reject") {
      send({ id: message.id, error: { code: -32601, message: "review/start unavailable" } });
      return;
    }
    if (mode === "hang") return;
    if (mode === "delayed") {
      return setTimeout(() => {
        send({ id: message.id, result: { reviewThreadId: "thread-1", turn: { id: "turn-1", status: "inProgress" } } });
        setTimeout(() => {
          send({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { type: "exitedReviewMode", review: "native review result" } } });
          send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });
        }, 20);
      }, 1_200);
    }
    send({ id: message.id, result: { reviewThreadId: "thread-1", turn: { id: "turn-1", status: "inProgress" } } });
    if (mode === "exit") return setTimeout(() => process.exit(9), 30);
    if (mode === "fail") {
      return setTimeout(() => send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "failed", error: { message: "review failed" } } } }), 20);
    }
    if (mode === "cancel") return;
    setTimeout(() => {
      send({ method: "item/started", params: { threadId: "thread-1", turnId: "turn-1", item: { type: "mcpToolCall", server: "fake", tool: "read" } } });
      send({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { type: "exitedReviewMode", review: "native review result" } } });
      send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });
    }, 20);
    return;
  }
  if (message.method === "turn/interrupt") {
    send({ id: message.id, result: {} });
    send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "interrupted" } } });
  }
});
`,
    { mode: 0o600 }
  );
  return { bin: process.execPath, args: [p] };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ───────────────────────────────── 1. Флаг --ask-for-approval по capabilities

await t("1. --ask-for-approval не добавляется, если exec его не поддерживает", async () => {
  const d = fresh("caps");
  const bin = fakeCodex(d);
  process.env.CODEX_BIN = bin;
  process.env.CLAUDE_PLUGIN_DATA = path.join(d, "data");
  const core = await import(`${ROOT_URL}/scripts/codex-core.mjs?caps=${Date.now()}`);

  const args = core.buildArgs({ mode: "delegate", cwd: d });
  assert.ok(!args.includes("--ask-for-approval"), "флаг добавлен, хотя help его не содержит");
  assert.ok(args.includes("--sandbox"), "--sandbox должен присутствовать");
});

await tExec("1b. --ask-for-approval добавляется, когда exec его поддерживает", async () => {
  const d = fresh("caps2");
  process.env.CODEX_BIN = fakeCodex(d);
  process.env.CLAUDE_PLUGIN_DATA = path.join(d, "data");
  process.env.FAKE_HELP = "Usage: codex exec\n  --sandbox <mode>\n  --ask-for-approval <policy>\n  --cd <dir>";
  const core = await import(`${ROOT_URL}/scripts/codex-core.mjs?caps2=${Date.now()}`);
  const args = core.buildArgs({ mode: "delegate", cwd: d });
  assert.ok(args.includes("--ask-for-approval"));
  delete process.env.FAKE_HELP;
});

// image-core.mjs берёт возможности из codex-core.mjs, а тот запоминает их в
// модульной переменной. Query-параметр в импорте создаёт новый экземпляр только
// самого image-core: его статический `import "./codex-core.mjs"` — один и тот же
// URL для всех тестов, поэтому проба выполняется один раз за прогон. Без
// принудительного пересчёта тест 1d видел бы возможности, снятые в 1c.
await t("1c. генерация изображений не добавляет --ask-for-approval без поддержки в exec", async () => {
  const d = fresh("caps-image");
  process.env.CODEX_BIN = fakeCodex(d);
  process.env.CLAUDE_PLUGIN_DATA = path.join(d, "data");
  const core = await import(`${ROOT_URL}/scripts/codex-core.mjs`);
  core.capabilities({ force: true });
  const image = await import(`${ROOT_URL}/scripts/image-core.mjs?caps3=${Date.now()}`);

  const args = image.buildImageArgs({ cwd: d });
  assert.ok(!args.includes("--ask-for-approval"), "флаг добавлен, хотя help его не содержит");
  assert.ok(args.includes("--sandbox"), "--sandbox должен присутствовать");
});

await tExec("1d. генерация изображений добавляет --ask-for-approval, когда exec его поддерживает", async () => {
  const d = fresh("caps-image2");
  process.env.CODEX_BIN = fakeCodex(d);
  process.env.CLAUDE_PLUGIN_DATA = path.join(d, "data");
  process.env.FAKE_HELP = "Usage: codex exec\n  --sandbox <mode>\n  --ask-for-approval <policy>\n  --cd <dir>";
  const core = await import(`${ROOT_URL}/scripts/codex-core.mjs`);
  core.capabilities({ force: true });
  try {
    const image = await import(`${ROOT_URL}/scripts/image-core.mjs?caps4=${Date.now()}`);
    const args = image.buildImageArgs({ cwd: d });
    assert.ok(args.includes("--ask-for-approval"));
  } finally {
    // Возможности запомнены в общем экземпляре codex-core. Не вернув их к
    // умолчанию — в том числе при провале проверки выше — мы протащили бы
    // --ask-for-approval в остальные тесты image-core.
    delete process.env.FAKE_HELP;
    core.capabilities({ force: true });
  }
});

await t("1e. неудачная проба возможностей не выдаётся за достоверную", async () => {
  const d = fresh("caps-broken");
  // В роли сломанного codex — node: `node exec --help` пишет ошибку в stderr
  // и выходит с ненулевым кодом. Это работает и на Windows, в отличие от
  // shebang-заглушки, поэтому тест выполняется на всех платформах.
  process.env.CODEX_BIN = process.execPath;
  process.env.CLAUDE_PLUGIN_DATA = path.join(d, "data");
  const core = await import(`${ROOT_URL}/scripts/codex-core.mjs`);
  try {
    const caps = core.capabilities({ force: true });
    assert.equal(caps.probed, false, "непустой stderr принят за прочитанный help");
    // Проба не удалась — базовые флаги остаются включёнными, иначе buildArgs
    // выродится в ["exec", "-"] и Codex уйдёт работать в каталог процесса.
    for (const f of ["sandbox", "cd", "skipGitRepoCheck", "image"]) {
      assert.equal(caps[f], true, `${f} выключен после неудачной пробы`);
    }
    const args = core.buildArgs({ mode: "delegate", cwd: d });
    assert.ok(args.includes("--cd"), "--cd потерян");
    assert.ok(args.includes("--sandbox"), "--sandbox потерян");
    assert.ok(
      !fs.existsSync(path.join(d, "data", "exec-caps.json")),
      "неудачная проба записана на диск и переживёт перезапуск"
    );
  } finally {
    core.capabilities({ force: true });
  }
});

await t("1f. лента начинается с вопроса, а не с первого действия модели", async () => {
  const ev = await import(`${ROOT_URL}/scripts/codex-events.mjs?asked=${Date.now()}`);

  assert.match(ev.askedLine({ question: "почему падает ретрай вебхука" }), /почему падает ретрай вебхука/);
  // Приоритет полей: у codex_chat вопрос лежит в message, у codex_review — в focus.
  assert.match(ev.askedLine({ message: "продолжим про кэш" }), /продолжим про кэш/);
  assert.match(ev.askedLine({ focus: "схема ретраев" }), /схема ретраев/);
  assert.match(ev.askedLine({ task: "почини падающие тесты" }), /почини падающие тесты/);

  // Переводы строк ломают ленту: одна строка на событие.
  assert.ok(!/\n/.test(ev.askedLine({ question: "первая строка\nвторая строка" })), "перенос строки попал в ленту");

  // Длинный вопрос обрезается: лента — не место для промпта целиком.
  const long = ev.askedLine({ question: "я".repeat(400) });
  assert.ok(long.length < 220, `строка ленты не обрезана: ${long.length}`);
  assert.match(long, /…$/, "обрезка без многоточия");

  assert.equal(ev.askedLine({}), null, "пустые аргументы дали строку ленты");
  assert.equal(ev.askedLine({ question: "   " }), null, "пробелы приняты за вопрос");
  assert.equal(ev.askedLine(undefined), null, "отсутствие аргументов уронило формирование ленты");
});

// ───────────────────────────────── 2. Терминальные статусы фоновых задач

await tExec("2a. cancel не перезаписывается завершением процесса", async () => {
  const d = fresh("jobs-cancel");
  process.env.CODEX_BIN = fakeCodex(d);
  process.env.CLAUDE_PLUGIN_DATA = path.join(d, "data");
  process.env.FAKE = "slow";
  const core = await import(`${ROOT_URL}/scripts/codex-core.mjs?c=${Date.now()}`);

  const job = core.startJob({ mode: "delegate", task: "x", cwd: d });
  await sleep(300);
  core.cancelJob(job.id);
  assert.equal(core.resolveJob(job.id, d).status, "cancelled", "сразу после отмены");
  await sleep(1200);
  assert.equal(core.resolveJob(job.id, d).status, "cancelled", "после завершения процесса");
  delete process.env.FAKE;
});

await tExec("2b. код возврата переживает перезапуск, ненулевой != done", async () => {
  const d = fresh("jobs-exit");
  process.env.CODEX_BIN = fakeCodex(d);
  process.env.CLAUDE_PLUGIN_DATA = path.join(d, "data");
  process.env.FAKE = "exit7";
  const core = await import(`${ROOT_URL}/scripts/codex-core.mjs?e=${Date.now()}`);

  const job = core.startJob({ mode: "delegate", task: "x", cwd: d });
  await sleep(1200);
  // Имитируем перезапуск: свежий модуль, обработчика exit нет
  const core2 = await import(`${ROOT_URL}/scripts/codex-core.mjs?e2=${Date.now()}`);
  const j = core2.resolveJob(job.id, d);
  assert.equal(j.status, "failed", `ожидался failed, получено ${j.status}`);
  assert.equal(j.exitCode, 7);
  delete process.env.FAKE;
});

await tExec("2c. дескрипторы не текут при массовом запуске", async () => {
  const d = fresh("jobs-fd");
  process.env.CODEX_BIN = fakeCodex(d);
  process.env.CLAUDE_PLUGIN_DATA = path.join(d, "data");
  process.env.TANDEM_MAX_PARALLEL_JOBS = "0"; // тест про дескрипторы, предел здесь мешает
  const core = await import(`${ROOT_URL}/scripts/codex-core.mjs?fd=${Date.now()}`);

  const count = () => {
    try {
      return fs.readdirSync(`/proc/${process.pid}/fd`).length;
    } catch {
      return -1;
    }
  };
  const before = count();
  if (before < 0) return; // не Linux — пропускаем
  for (let i = 0; i < 40; i++) core.startJob({ mode: "delegate", task: `t${i}`, cwd: d });
  await sleep(200);
  const leaked = count() - before;
  assert.ok(leaked < 10, `утечка ${leaked} дескрипторов на 40 задач`);
  delete process.env.TANDEM_MAX_PARALLEL_JOBS;
});

// ───────────────────────────────── 3. Path traversal через job_id

await t("3. job_id вне шаблона отвергается", async () => {
  const d = fresh("traversal");
  process.env.CODEX_BIN = fakeCodex(d);
  process.env.CLAUDE_PLUGIN_DATA = path.join(d, "data");
  const core = await import(`${ROOT_URL}/scripts/codex-core.mjs?tr=${Date.now()}`);

  const outside = path.join(d, "outside-job.json");
  fs.mkdirSync(path.dirname(outside), { recursive: true });
  fs.writeFileSync(outside, JSON.stringify({ id: "x", pid: 1, status: "running" }));

  for (const bad of ["../../outside-job", "../outside-job", "job-XXXX", "job-1234567", "/etc/passwd", ""]) {
    assert.equal(core.resolveJob(bad, d), null, `принят недопустимый id: ${bad}`);
    const c = core.cancelJob(bad);
    assert.equal(c.ok, false, `cancelJob принял: ${bad}`);
  }
  assert.equal(core.jobOutput("../../etc/passwd"), "", "jobOutput прочитал внешний файл");
});

// ───────────────────────────────── 4. Ограничение инструментов claude_task

await t("4. Codex не может расширить allowlist администратора", async () => {
  const d = fresh("tools");
  const argvFile = path.join(d, "claude-argv.json");
  fs.writeFileSync(
    path.join(d, "claude"),
    `#!/usr/bin/env node
require("fs").writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));
console.log("ok");`,
    { mode: 0o755 }
  );
  const exposed = path.join(d, "exposed.json");
  fs.writeFileSync(exposed, JSON.stringify({ servers: {}, allow_task: true, task_tools: ["Read"] }));

  const res = await talk(
    `${ROOT}/bridge/mcp-claude.mjs`,
    [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "claude_task", arguments: { task: "x", allowed_tools: ["Edit", "Bash"], write: true } },
      },
    ],
    { CLAUDE_BIN: path.join(d, "claude"), TANDEM_EXPOSED: exposed }
  );
  assert.ok(res.length >= 2, "мост не ответил");
  const call = res.find((m) => m.id === 2);
  assert.equal(call.result.isError, true, "расширение allowlist не отклонено");
  assert.match(call.result.content[0].text, /not in the allowed set|cannot expand it/);
  assert.ok(!fs.existsSync(argvFile), "claude был запущен, хотя запрос вне allowlist");
});

await tExec("4b. при write:false write-инструменты вырезаны принудительно", async () => {
  const d = fresh("tools-ro");
  const argvFile = path.join(d, "claude-argv.json");
  fs.writeFileSync(
    path.join(d, "claude"),
    `#!/usr/bin/env node
require("fs").writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));
console.log("ok");`,
    { mode: 0o755 }
  );
  const exposed = path.join(d, "exposed.json");
  fs.writeFileSync(
    exposed,
    JSON.stringify({ servers: {}, allow_task: true, task_tools: ["Read", "Edit", "Bash"] })
  );
  await talk(
    `${ROOT}/bridge/mcp-claude.mjs`,
    [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "claude_task", arguments: { task: "x", write: false } },
      },
    ],
    { CLAUDE_BIN: path.join(d, "claude"), TANDEM_EXPOSED: exposed }
  );
  const argv = JSON.parse(fs.readFileSync(argvFile, "utf8"));
  assert.ok(argv.includes("--tools"), `использован не --tools: ${argv.join(" ")}`);
  assert.ok(!argv.includes("--allowedTools"), "--allowedTools не ограничивает набор, использовать нельзя");
  const passed = argv[argv.indexOf("--tools") + 1].split(",").filter(Boolean);
  for (const w of ["Edit", "Bash", "Write"]) {
    assert.ok(!passed.includes(w), `${w} не вырезан при write:false`);
  }
  assert.ok(argv.includes("--disallowedTools"), "нет страховочного --disallowedTools");
});

// ───────────────────────────────── 5. Валидация изображений

await tExec("5a. текстовый файл не принимается за изображение", async () => {
  const d = fresh("img-fake");
  // Тексты проверяются по-русски, значит язык задаётся явно: по умолчанию он
  // английский, и без этого тест проверял бы не поведение, а язык среды.
  process.env.TANDEM_LANG = "ru";
  const stray = path.join(d, "gen");
  fs.mkdirSync(stray, { recursive: true });
  process.env.CODEX_BIN = fakeCodex(d);
  process.env.CODEX_HOME = d;
  process.env.FAKE = "notimage";
  process.env.FAKE_STRAY = stray;
  const img = await import(`${ROOT_URL}/scripts/image-core.mjs?i=${Date.now()}`);
  const r = img.generateImage({ prompt: "x", cwd: d });
  assert.equal(r.ok, false, "текстовый файл принят как изображение");
  assert.match(r.error, /не является изображением|вне проекта/);
  delete process.env.FAKE;
  delete process.env.TANDEM_LANG;
});

await t("5b. out_dir с .. и абсолютный путь отвергаются", async () => {
  const d = fresh("img-path");
  process.env.CODEX_BIN = fakeCodex(d);
  const img = await import(`${ROOT_URL}/scripts/image-core.mjs?p=${Date.now()}`);
  for (const bad of ["../outside-images", "/tmp/anywhere", "a/../../b"]) {
    const r = img.generateImage({ prompt: "x", out_dir: bad, cwd: d });
    assert.equal(r.ok, false, `принят out_dir: ${bad}`);
  }
});

await t("5c. SAVED вне проекта и вне каталога Codex отвергается", async () => {
  const d = fresh("img-outside");
  process.env.CODEX_BIN = fakeCodex(d);
  process.env.CODEX_HOME = path.join(d, "codexhome");
  fs.mkdirSync(path.join(d, "codexhome", "generated_images"), { recursive: true });
  process.env.FAKE = "outside";
  const img = await import(`${ROOT_URL}/scripts/image-core.mjs?o=${Date.now()}`);
  const r = img.generateImage({ prompt: "x", cwd: d });
  assert.equal(r.ok, false, "принят файл извне проекта");
  delete process.env.FAKE;
});

await tExec("5d. ненулевой код Codex не считается успехом", async () => {
  const d = fresh("img-exit");
  process.env.TANDEM_LANG = "ru";
  process.env.CODEX_BIN = fakeCodex(d);
  process.env.FAKE = "exit7";
  const img = await import(`${ROOT_URL}/scripts/image-core.mjs?x=${Date.now()}`);
  const r = img.generateImage({ prompt: "x", cwd: d });
  assert.equal(r.ok, false);
  assert.match(r.error, /кодом 7/);
  delete process.env.FAKE;
  delete process.env.TANDEM_LANG;
});

// ───────────────────────────────── 6. Безопасность config.toml

await t("6a. $& в пути не портит блок", async () => {
  const d = fresh("toml-amp");
  const cfg = path.join(d, "config.toml");
  process.env.TANDEM_CONFIG = cfg;
  const root = path.join(d, "plug$&in");
  fs.mkdirSync(path.join(root, "bridge"), { recursive: true });
  fs.writeFileSync(path.join(root, "bridge", "mcp-claude.mjs"), "");
  const lb = await import(`${ROOT_URL}/scripts/link-back.mjs?a=${Date.now()}`);
  lb.link(root);
  assert.equal(lb.linkedPath(), path.join(root, "bridge", "mcp-claude.mjs"));
  assert.ok(!fs.readFileSync(cfg, "utf8").includes(">>> tandem (claude) >>>\n# Управляется".repeat(2)));
});

await tExec("6b. кавычка в пути даёт валидную TOML-строку", async () => {
  const d = fresh("toml-quote");
  process.env.TANDEM_CONFIG = path.join(d, "config.toml");
  const root = path.join(d, 'pl"ug');
  fs.mkdirSync(path.join(root, "bridge"), { recursive: true });
  fs.writeFileSync(path.join(root, "bridge", "mcp-claude.mjs"), "");
  const lb = await import(`${ROOT_URL}/scripts/link-back.mjs?q=${Date.now()}`);
  lb.link(root);
  const txt = fs.readFileSync(process.env.TANDEM_CONFIG, "utf8");
  assert.match(txt, /args = \["[^"]*\\"[^"]*"\]/, "кавычка не экранирована");
  assert.equal(lb.linkedPath(), path.join(root, "bridge", "mcp-claude.mjs"));
});

await t("6c. unlink удаляет все управляемые блоки", async () => {
  const d = fresh("toml-dup");
  const cfg = path.join(d, "config.toml");
  process.env.TANDEM_CONFIG = cfg;
  const blk = (p) =>
    `# >>> tandem (claude) >>>\n[mcp_servers.claude-bridge]\ncommand = "node"\nargs = ["${p}"]\n# <<< tandem (claude) <<<\n`;
  fs.writeFileSync(cfg, `model = "x"\n\n${blk("/old/1")}\n${blk("/old/2")}\n`);
  const lb = await import(`${ROOT_URL}/scripts/link-back.mjs?d=${Date.now()}`);
  lb.unlink();
  const txt = fs.readFileSync(cfg, "utf8");
  assert.ok(!txt.includes("tandem"), "остались блоки");
  assert.match(txt, /model = "x"/, "пользовательские настройки потеряны");
});

await t("6d. конфликт с чужой таблицей обнаруживается, файл не портится", async () => {
  const d = fresh("toml-conflict");
  const cfg = path.join(d, "config.toml");
  process.env.TANDEM_CONFIG = cfg;
  const original = '[mcp_servers.claude-bridge]\ncommand = "my-own"\n';
  fs.writeFileSync(cfg, original);
  const root = path.join(d, "plug");
  fs.mkdirSync(path.join(root, "bridge"), { recursive: true });
  fs.writeFileSync(path.join(root, "bridge", "mcp-claude.mjs"), "");
  const lb = await import(`${ROOT_URL}/scripts/link-back.mjs?cf=${Date.now()}`);
  const r = lb.link(root);
  assert.equal(r.action, "conflict");
  assert.equal(fs.readFileSync(cfg, "utf8"), original, "файл изменён при конфликте");
});

// ───────────────────────────────── 7. Ненулевой код задачи

await tExec("7. runJob: частичный вывод при exit!=0 не выдаётся за успех", async () => {
  const d = fresh("exitcode");
  process.env.CODEX_BIN = fakeCodex(d);
  process.env.CLAUDE_PLUGIN_DATA = path.join(d, "data");
  process.env.FAKE = "exit7";
  const core = await import(`${ROOT_URL}/scripts/codex-core.mjs?ec=${Date.now()}`);
  const r = await core.runJob({ mode: "ask", question: "x", cwd: d }, { waitMs: 20_000 });
  assert.equal(r.ok, false, "частичный вывод принят за успех");
  assert.equal(r.exitCode, 7);
  assert.equal(r.partialOutput, "PARTIAL OUTPUT");
  assert.ok(/fatal detail/.test(r.error || ""), "stderr не доехал до диагностики отказа");
  delete process.env.FAKE;
});

await t("7b. потоки в журнале различимы: stderr не подмешивается в ответ", async () => {
  const ev = await import(`${ROOT_URL}/scripts/codex-events.mjs?st=${Date.now()}`);
  const log = [
    JSON.stringify({ type: ev.STDOUT_LINE, text: "ответ модели" }),
    JSON.stringify({ type: ev.STDERR_LINE, text: "failed to load models cache" }),
    JSON.stringify({ type: ev.STDOUT_LINE, text: "вторая строка" }),
  ].join("\n");

  assert.equal(ev.hasStreamTags(log), true);
  assert.equal(ev.extractOutput(log).text, "ответ модели\nвторая строка", "stderr попал в ответ модели");
  assert.equal(ev.streamText(log, "stderr"), "failed to load models cache");
});

await t("7c. служебные метки потоков не показываются как шаги работы", async () => {
  const ev = await import(`${ROOT_URL}/scripts/codex-events.mjs?tr=${Date.now()}`);
  const log = [
    JSON.stringify({ type: "thread.started", thread_id: "t-1" }),
    JSON.stringify({ type: ev.STDOUT_LINE, text: "сырая строка" }),
    JSON.stringify({ type: ev.STDERR_LINE, text: "шум" }),
  ].join("\n");

  const trail = ev.progressTrail(log, { limit: 10 });
  assert.deepEqual(trail, ["session opened"], `метки утекли в ленту: ${JSON.stringify(trail)}`);
});

await t("7d. журнал прежнего формата читается по-старому", async () => {
  const ev = await import(`${ROOT_URL}/scripts/codex-events.mjs?old=${Date.now()}`);
  const log = ["голый текст без меток", JSON.stringify({ type: "turn.started" })].join("\n");
  assert.equal(ev.hasStreamTags(log), false, "журнал без меток опознан как помеченный");
  assert.equal(ev.streamText(log, "stdout"), "");
});

// ───────────────────────────────── 8. Права и секреты

await tExec("8. exposed.json создаётся с 0600 и без литеральных секретов", async () => {
  const d = fresh("perm");
  const exposed = path.join(d, "cfg", "exposed.json");
  process.env.TANDEM_EXPOSED = exposed;
  const tp = await import(`${ROOT_URL}/bridge/tool-proxy.mjs?perm=${Date.now()}`);

  const { env, dropped } = tp.sanitizeEnv({ TOKEN: "sk-literal-secret", REF: "${MY_VAR}" });
  assert.deepEqual(Object.keys(env), ["REF"], "литеральный секрет попал в конфиг");
  assert.deepEqual(dropped, ["TOKEN"]);

  tp.writeExposed({ servers: {}, allow_task: false });
  const mode = fs.statSync(exposed).mode & 0o777;
  assert.equal(mode, 0o600, `права ${mode.toString(8)} вместо 600`);
  assert.equal(fs.statSync(path.dirname(exposed)).mode & 0o777, 0o700);
});

await t("8b. ${VAR} раскрывается при запуске", async () => {
  const tp = await import(`${ROOT_URL}/bridge/tool-proxy.mjs?ex=${Date.now()}`);
  process.env.MY_TEST_VAR = "value-42";
  assert.equal(tp.expandEnv("${MY_TEST_VAR}"), "value-42");
  assert.equal(tp.expandEnv("${NOT_SET_VAR:-fallback}"), "fallback");
  delete process.env.MY_TEST_VAR;
});

// ───────────────────────────────── 9. Неполный каталог не блокирует

await tExec("9. при неполном каталоге незнакомая модель пропускается", async () => {
  const d = fresh("models");
  process.env.CODEX_BIN = fakeCodex(d);
  process.env.CLAUDE_PLUGIN_DATA = path.join(d, "data");
  process.env.FAKE_MODELS = "not json at all";
  fs.mkdirSync(path.join(d, ".codex"), { recursive: true });
  const prevCwd = process.cwd();
  process.chdir(d);
  fs.mkdirSync(path.join(d, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(d, ".codex", "config.toml"), 'model = "configured-only"\n');

  const m = await import(`${ROOT_URL}/scripts/models.mjs?m=${Date.now()}`);
  const r = m.fetchModels({ force: true });
  assert.equal(r.complete, false, "неполный каталог помечен как полный");
  const k = m.knownModel("some-other-model");
  assert.equal(k.known, true, "рабочая модель отклонена по неполному каталогу");
  process.chdir(prevCwd);
  delete process.env.FAKE_MODELS;
});

await tExec("9b. каталог, окружённый служебным текстом, разбирается", async () => {
  const d = fresh("models2");
  process.env.CODEX_BIN = fakeCodex(d);
  process.env.CLAUDE_PLUGIN_DATA = path.join(d, "data");
  process.env.FAKE_MODELS = 'notice\n{"models":[{"id":"m-one","display_name":"One"}]}\nnotice after';
  const m = await import(`${ROOT_URL}/scripts/models.mjs?m2=${Date.now()}`);
  const r = m.fetchModels({ force: true });
  assert.equal(r.ok, true, r.error);
  assert.ok(
    r.models.some((x) => x.id === "m-one"),
    `каталог не разобран: ${JSON.stringify(r.models)}`
  );
  delete process.env.FAKE_MODELS;
});

// ───────────────────────────────── 9c/9d. Уровни усилий (найдено на живом Codex)

await tExec("9c. effort сверяется с supported_reasoning_efforts модели", async () => {
  const d = fresh("efforts");
  process.env.CODEX_BIN = fakeCodex(d);
  process.env.CLAUDE_PLUGIN_DATA = path.join(d, "data");
  process.env.FAKE_MODELS = JSON.stringify({
    models: [
      { id: "gpt-5.6-sol", display_name: "Sol", supported_reasoning_efforts: ["none", "low", "medium", "high", "xhigh", "max"] },
      { id: "old-model", display_name: "Old", supported_reasoning_efforts: ["minimal", "low"] },
    ],
  });
  const m = await import(`${ROOT_URL}/scripts/models.mjs?eff=${Date.now()}`);
  m.fetchModels({ force: true });

  // minimal реально отвергается gpt-5.6-sol — это и сломалось на живом запуске
  assert.ok(m.validateEffort("gpt-5.6-sol", "minimal"), "minimal пропущен для модели, которая его не принимает");
  assert.equal(m.validateEffort("gpt-5.6-sol", "low"), null, "low отклонён");
  assert.equal(m.validateEffort("gpt-5.6-sol", "xhigh"), null, "xhigh отклонён");
  assert.equal(m.validateEffort("old-model", "minimal"), null, "minimal отклонён у модели, которая его принимает");
  assert.ok(m.validateEffort("gpt-5.6-sol", "turbo"), "несуществующий уровень пропущен");
  delete process.env.FAKE_MODELS;
});

await t("9d. при неполном каталоге effort не блокируется", async () => {
  const d = fresh("efforts2");
  process.env.CODEX_BIN = fakeCodex(d);
  process.env.CLAUDE_PLUGIN_DATA = path.join(d, "data");
  process.env.FAKE_MODELS = "not json";
  const prev = process.cwd();
  process.chdir(d);
  fs.mkdirSync(path.join(d, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(d, ".codex", "config.toml"), 'model = "unknown-model"\n');
  const m = await import(`${ROOT_URL}/scripts/models.mjs?eff2=${Date.now()}`);
  m.fetchModels({ force: true });
  assert.equal(m.validateEffort("unknown-model", "high"), null, "заблокировал по неполному каталогу");
  process.chdir(prev);
  delete process.env.FAKE_MODELS;
});

await t("9e. отказ API по уровню усилий объясняется, шум кэша Codex отфильтрован", async () => {
  const core = await import(`${ROOT_URL}/scripts/codex-core.mjs?exp=${Date.now()}`);

  const stderr = [
    "2026-08-03T11:44:27.127313Z ERROR codex_models_manager::cache: failed to load models cache: missing field `supports_reasoning_summaries` at line 86 column 5",
    "Unsupported value: 'minimal' is not supported with the 'gpt-5.6-sol-1p-codexswic-ev3' model.",
    "Supported values are: 'none', 'low', 'medium', 'high', 'xhigh', and 'max'.",
  ].join("\n");

  const clean = core.denoise(stderr);
  assert.ok(!/models cache/.test(clean), "служебный шум Codex не отфильтрован");
  assert.ok(/Unsupported value/.test(clean), "полезная строка потеряна");

  const reason = core.explainCodexFailure(clean);
  assert.ok(reason, "причина не распознана");
  assert.match(reason, /does not accept effort level "minimal"/);
  assert.match(reason, /low/, "не перечислены поддерживаемые значения");

  assert.match(core.explainCodexFailure("Error: not logged in"), /codex login/);
  const flag = core.explainCodexFailure("error: unexpected argument '--ask-for-approval'");
  assert.match(flag, /--ask-for-approval/);
  assert.match(flag, /Update the plugin|Обнови плагин/, "совет должен начинаться с обновления плагина");
});

// ─────────── 9f–9j. Каталог реальной формы (найдено на codex-cli 0.153.4)

// Форма записи, которую Codex действительно отдаёт: ключ модели — slug, уровни
// усилий лежат в supported_reasoning_levels массивом объектов, а внутри записи
// есть service_tiers — набор объектов с id и name, но это не модели.
const LIVE_ENTRY = {
  slug: "gpt-5.6-sol",
  display_name: "GPT-5.6-Sol",
  description: "Our most capable model.",
  default_reasoning_level: "low",
  supported_reasoning_levels: [
    { effort: "low", description: "Fast responses" },
    { effort: "high", description: "Greater depth" },
    { effort: "ultra", description: "Maximum depth" },
  ],
  visibility: "list",
  service_tiers: [{ id: "priority", name: "Fast", description: "1.5x speed, increased usage" }],
};

await t("9f. уровни усилий читаются из supported_reasoning_levels", async () => {
  const m = await import(`${ROOT_URL}/scripts/models.mjs?live=${Date.now()}`);
  const parsed = m.parseCatalog({ models: [LIVE_ENTRY] });
  const sol = parsed.find((x) => x.id === "gpt-5.6-sol");
  assert.ok(sol, `модель не разобрана: ${JSON.stringify(parsed)}`);
  assert.deepEqual(sol.efforts, ["low", "high", "ultra"], "уровни усилий не прочитаны");
});

await t("9g. service_tiers внутри модели не становится моделью", async () => {
  const m = await import(`${ROOT_URL}/scripts/models.mjs?tiers=${Date.now()}`);
  const ids = m.parseCatalog({ models: [LIVE_ENTRY] }).map((x) => x.id);
  assert.deepEqual(ids, ["gpt-5.6-sol"], `в каталог попали посторонние записи: ${ids.join(", ")}`);
});

await t("9h. пустой список моделей не подменяется обходом дерева", async () => {
  const m = await import(`${ROOT_URL}/scripts/models.mjs?empty=${Date.now()}`);
  const ids = m.parseCatalog({ models: [], service_tiers: [{ id: "priority", name: "Fast" }] }).map((x) => x.id);
  assert.deepEqual(ids, [], `явно пустой каталог дополнен: ${ids.join(", ")}`);
});

await t("9i. модель, которой нет в полном каталоге, не блокируется", async () => {
  const d = fresh("catalog-miss");
  process.env.CLAUDE_PLUGIN_DATA = d;
  const m = await import(`${ROOT_URL}/scripts/models.mjs?miss=${Date.now()}`);
  fs.writeFileSync(
    path.join(d, "models-cache.json"),
    JSON.stringify({
      v: m.CACHE_VERSION,
      at: Date.now(),
      source: "codex debug models",
      complete: true,
      models: [{ id: "gpt-5.6-sol", label: "Sol", efforts: ["low"] }],
    })
  );
  // Каталог отстаёт от реальной доступности: gpt-6-astra работал в codex exec,
  // когда debug models его ещё не перечислял. Решает API, а не каталог.
  const k = m.knownModel("gpt-6-astra");
  assert.equal(k.known, true, "рабочая модель отклонена по каталогу");
  assert.equal(k.unverified, true, "пропуск не помечен как непроверенный");
});

await t("9j. кэш прежнего формата не используется", async () => {
  const d = fresh("catalog-oldcache");
  process.env.CLAUDE_PLUGIN_DATA = d;
  process.env.CODEX_BIN = path.join(d, "no-such-codex");
  fs.writeFileSync(
    path.join(d, "models-cache.json"),
    // Записан до исправления разбора: efforts потеряны, есть фантомный service tier.
    JSON.stringify({
      at: Date.now(),
      source: "codex debug models",
      complete: true,
      models: [{ id: "priority", label: "Fast", efforts: null }],
    })
  );
  const m = await import(`${ROOT_URL}/scripts/models.mjs?oldcache=${Date.now()}`);
  const r = m.fetchModels();
  assert.ok(
    !r.models?.some((x) => x.id === "priority"),
    "кэш прежнего формата отдан как есть"
  );
  delete process.env.CODEX_BIN;
});

await t("9k. уровень из каталога не режется зашитым списком", async () => {
  const d = fresh("catalog-ultra");
  process.env.CLAUDE_PLUGIN_DATA = d;
  const m = await import(`${ROOT_URL}/scripts/models.mjs?ultra=${Date.now()}`);
  fs.writeFileSync(
    path.join(d, "models-cache.json"),
    JSON.stringify({
      v: m.CACHE_VERSION,
      at: Date.now(),
      source: "codex debug models",
      complete: true,
      models: [{ id: "gpt-5.6-sol", label: "Sol", efforts: ["low", "high", "ultra"] }],
    })
  );
  assert.equal(m.validateEffort("gpt-5.6-sol", "ultra"), null, "ultra отклонён, хотя каталог его объявляет");
  assert.ok(m.effortLevels().includes("ultra"), "ultra не попал в схему инструментов");
});

// ───────────────── 14. Нераскрытые плейсхолдеры (найдено при первом запуске)

await t("14a. литеральный ${CLAUDE_PLUGIN_DATA} не создаёт каталог в проекте", async () => {
  const d = fresh("placeholder");
  const prev = process.cwd();
  process.chdir(d);
  process.env.CLAUDE_PLUGIN_DATA = "${CLAUDE_PLUGIN_DATA}"; // подстановка не сработала
  const core = await import(`${ROOT_URL}/scripts/codex-core.mjs?ph=${Date.now()}`);
  const dir = core.dataDir();

  assert.ok(path.isAbsolute(dir), `относительный путь: ${dir}`);
  assert.ok(!dir.includes("${"), `плейсхолдер попал в путь: ${dir}`);
  assert.ok(
    !fs.existsSync(path.join(d, "${CLAUDE_PLUGIN_DATA}")),
    "в проекте создан каталог с именем плейсхолдера"
  );
  process.chdir(prev);
  delete process.env.CLAUDE_PLUGIN_DATA;
});

await t("14b. относительный CLAUDE_PLUGIN_DATA отвергается", async () => {
  const d = fresh("relative");
  const prev = process.cwd();
  process.chdir(d);
  process.env.CLAUDE_PLUGIN_DATA = "some/relative/dir";
  const core = await import(`${ROOT_URL}/scripts/codex-core.mjs?rel=${Date.now()}`);
  assert.ok(path.isAbsolute(core.dataDir()));
  assert.ok(!fs.existsSync(path.join(d, "some")), "создан относительный каталог в проекте");
  process.chdir(prev);
  delete process.env.CLAUDE_PLUGIN_DATA;
});

await t("14c. нераскрытый ${user_config.*} не уходит в аргументы codex", async () => {
  const d = fresh("usercfg");
  process.env.CODEX_BIN = fakeCodex(d);
  process.env.CLAUDE_PLUGIN_DATA = path.join(d, "data");
  process.env.TANDEM_MODEL = "${user_config.default_model}";
  process.env.TANDEM_EFFORT = "${user_config.default_effort}";
  const core = await import(`${ROOT_URL}/scripts/codex-core.mjs?uc=${Date.now()}`);
  const args = core.buildArgs({ mode: "ask", cwd: d });

  assert.ok(!args.some((a) => String(a).includes("${")), `плейсхолдер в аргументах: ${args.join(" ")}`);
  assert.ok(!args.includes("-m"), "пустая модель передана в -m");
  delete process.env.TANDEM_MODEL;
  delete process.env.TANDEM_EFFORT;
});

await t("14d. .mcp.json не переопределяет автоэкспортируемые CLAUDE_*", async () => {
  const mcp = JSON.parse(fs.readFileSync(`${ROOT}/.mcp.json`, "utf8"));
  for (const [name, srv] of Object.entries(mcp.mcpServers)) {
    for (const key of Object.keys(srv.env || {})) {
      assert.ok(
        !key.startsWith("CLAUDE_"),
        `сервер ${name} переопределяет ${key}, которая и так экспортируется Claude Code`
      );
    }
  }
});

// ────────── 15. Сбой песочницы Windows (найдено при запуске на Windows)

await t("15a. сбой песочницы распознаётся, а не выглядит отказом пользователя", async () => {
  const core = await import(`${ROOT_URL}/scripts/codex-core.mjs?sb=${Date.now()}`);

  const real =
    "windows sandbox: orchestrator_helper_launch_failed: setup refresh failed to " +
    "launch helper: helper=codex-windows-sandbox-setup.exe, error=program not found";
  const r = core.explainCodexFailure(real);
  assert.ok(r, "причина не распознана");
  assert.match(r, /sandbox/i);
  assert.match(r, /the bridge is fine/, "не сказано, что MCP-сервер тут ни при чём");
  assert.match(r, /npm install -g @openai\/codex/, "нет действия по починке");

  // Именно так сбой выходит наружу и увёл диагностику в сторону
  const masked = core.explainCodexFailure("user cancelled MCP tool call");
  assert.ok(masked, "маскированная форма не распознана");
  assert.match(masked, /песочниц|setup/i);
});

await tExec("15b. bypass_sandbox выключен по умолчанию и включается явно", async () => {
  const d = fresh("bypass");
  process.env.CODEX_BIN = fakeCodex(d);
  process.env.CLAUDE_PLUGIN_DATA = path.join(d, "data");
  process.env.FAKE_HELP =
    "Usage: codex exec\n  --sandbox <mode>\n  --cd <dir>\n  --dangerously-bypass-approvals-and-sandbox";

  delete process.env.TANDEM_BYPASS_SANDBOX;
  let core = await import(`${ROOT_URL}/scripts/codex-core.mjs?b1=${Date.now()}`);
  let args = core.buildArgs({ mode: "ask", cwd: d });
  assert.ok(!args.includes("--dangerously-bypass-approvals-and-sandbox"), "обход включён без настройки");
  assert.ok(args.includes("--sandbox"), "песочница не запрошена");

  // Нераскрытый плейсхолдер настройки не должен включать аварийный режим
  process.env.TANDEM_BYPASS_SANDBOX = "${user_config.bypass_sandbox}";
  core = await import(`${ROOT_URL}/scripts/codex-core.mjs?b2=${Date.now()}`);
  assert.equal(core.bypassSandboxEnabled(), false, "плейсхолдер включил обход");

  process.env.TANDEM_BYPASS_SANDBOX = "true";
  core = await import(`${ROOT_URL}/scripts/codex-core.mjs?b3=${Date.now()}`);
  args = core.buildArgs({ mode: "delegate", cwd: d });
  assert.ok(args.includes("--dangerously-bypass-approvals-and-sandbox"), "обход не применился");
  assert.ok(!args.includes("--sandbox"), "конфликтующие флаги переданы вместе");
  delete process.env.TANDEM_BYPASS_SANDBOX;
  delete process.env.FAKE_HELP;
});

await t("15c. рассинхрон версий Codex обнаруживается", async () => {
  const d = fresh("health");
  const home = path.join(d, "codexhome");
  fs.mkdirSync(path.join(home, ".sandbox-bin"), { recursive: true });
  process.env.CODEX_HOME = home;
  process.env.CODEX_BIN = fakeCodex(d); // сообщает версию 0.0.0-fake

  // Воспроизводим ровно наблюдавшуюся картину
  for (const f of [
    "codex-command-runner-0.145.0-alpha.18.exe",
    "codex-command-runner-0.146.0-alpha.3.1.exe",
    "codex-command-runner-0.146.0-alpha.9.2.exe",
  ]) {
    fs.writeFileSync(path.join(home, ".sandbox-bin", f), "");
  }
  fs.writeFileSync(path.join(home, "config.toml"), "[windows]\nsandbox = 'elevated'\n");

  const h = await import(`${ROOT_URL}/scripts/codex-health.mjs?h=${Date.now()}`);
  const bin = h.inspectSandboxBin();
  assert.equal(bin.hasWindowsSetup, false, "отсутствие windows-sandbox-setup не замечено");
  assert.deepEqual(bin.versions.sort(), ["0.145.0-alpha.18", "0.146.0-alpha.3.1", "0.146.0-alpha.9.2"]);
  assert.equal(h.windowsSandboxMode(), "elevated", "режим песочницы не прочитан из config.toml");

  const r = h.inspect();
  assert.ok(r.problems.length, "рассинхрон версий не отмечен как проблема");
  assert.match(h.format(r), /Solution:/, "нет готового действия");
  delete process.env.CODEX_HOME;
});

// ────────── 16. Прогресс вместо слепого таймаута

const JSONL = [
  '{"type":"thread.started","thread_id":"019f-abc"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"i0","type":"reasoning","text":"**Scanning docs for exec JSON schema**"}}',
  '{"type":"item.started","item":{"id":"i1","type":"command_execution","command":"bash -lc ls","status":"in_progress"}}',
  '{"type":"item.completed","item":{"id":"i1","type":"command_execution","command":"bash -lc ls","exit_code":0}}',
  '{"type":"error","message":"Reconnecting... 1/5"}',
  '{"type":"item.completed","item":{"id":"i2","type":"file_change","changes":[{"path":"src/a.ts"}]}}',
  '{"type":"item.completed","item":{"id":"i3","type":"agent_message","text":"Итоговый ответ модели."}}',
  '{"type":"turn.completed","usage":{"input_tokens":24763,"output_tokens":122}}',
].join("\n");

await t("16a. поток событий превращается в ленту действий и ответ", async () => {
  const ev = await import(`${ROOT_URL}/scripts/codex-events.mjs?e=${Date.now()}`);

  const { text: answer, events } = ev.extractOutput(JSONL);
  assert.equal(answer, "Итоговый ответ модели.", "ответ не извлечён из agent_message");
  assert.ok(ev.isFinished(events), "завершение не распознано");
  assert.deepEqual(ev.usageOf(events), { input_tokens: 24763, output_tokens: 122 });

  const trail = ev.progressTrail(JSONL);
  assert.ok(trail.some((l) => /thinking: Scanning docs/.test(l)), `нет рассуждений: ${trail}`);
  assert.ok(trail.some((l) => /running: ls/.test(l)), `нет запуска команды: ${trail}`);
  assert.ok(trail.some((l) => /editing files: src\/a\.ts/.test(l)), `нет правки файлов: ${trail}`);
  assert.ok(trail.some((l) => /reconnecting/.test(l)), "реконнект потерян");

  // Та же лента по-русски: подписи переключаются вместе с языком.
  process.env.TANDEM_LANG = "ru";
  const ruTrail = ev.progressTrail(JSONL);
  delete process.env.TANDEM_LANG;
  assert.ok(ruTrail.some((l) => /размышляет: Scanning docs/.test(l)), `лента не переключилась: ${ruTrail}`);
});

await t("16b. реконнект не считается фатальной ошибкой", async () => {
  const ev = await import(`${ROOT_URL}/scripts/codex-events.mjs?f=${Date.now()}`);
  assert.equal(ev.isFatalError({ type: "error", message: "Reconnecting... 1/5" }), false);
  assert.equal(ev.isFatalError({ type: "error", message: "stream broke" }), true);
  assert.equal(ev.isFatalError({ type: "turn.failed", error: { message: "boom" } }), true);
});

await t("16c. не-JSON вывод не теряется (старый Codex без --json)", async () => {
  const ev = await import(`${ROOT_URL}/scripts/codex-events.mjs?g=${Date.now()}`);
  const r = ev.extractOutput("обычный текстовый ответ\nвторая строка");
  assert.equal(r.text, "обычный текстовый ответ\nвторая строка", "текст потерян при отсутствии событий");
  assert.equal(r.events.length, 0);
});

await tExec("16d. таймаут показывает, что модель успела сделать", async () => {
  const d = fresh("timeout-trail");
  process.env.TANDEM_LANG = "ru";
  const bin = path.join(d, "codex");
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env node
const a=process.argv.slice(2);
if(a[0]==="--version"){console.log("codex 0.0.0-fake");process.exit(0)}
if(a[0]==="login"){console.log("Logged in");process.exit(0)}
if(a[0]==="exec"&&a[1]==="--help"){console.log("Usage: codex exec\\n  --json\\n  --sandbox <mode>\\n  --cd <dir>");process.exit(0)}
if(a[0]==="exec"){
  process.stdout.write(${JSON.stringify(JSONL.split("\n").slice(0, 5).join("\n") + "\n")});
  setTimeout(()=>process.exit(0), 60000); // зависаем после нескольких событий
}`,
    { mode: 0o755 }
  );
  process.env.CODEX_BIN = bin;
  process.env.CLAUDE_PLUGIN_DATA = path.join(d, "data");
  const core = await import(`${ROOT_URL}/scripts/codex-core.mjs?to=${Date.now()}`);

  const r = await core.runJob({ mode: "ask", question: "x", cwd: d }, { waitMs: 2500 });
  assert.equal(r.ok, false);
  assert.equal(r.timedOut, true, "таймаут не помечен");
  // Работа не убита и не перезапущена: та же задача продолжает идти
  assert.equal(core.resolveJob(r.job.id, d).status, "running", "задача убита по истечении ожидания");
  const trail = r.trail.join("\n");
  assert.match(trail, /размышляет|запускает/, `в ленте нет действий: ${trail}`);
  core.cancelJob(r.job.id);
  delete process.env.TANDEM_LANG;
});

await tExec("16e. --json добавляется в аргументы, когда поддержан", async () => {
  const d = fresh("jsonflag");
  process.env.CODEX_BIN = fakeCodex(d);
  process.env.CLAUDE_PLUGIN_DATA = path.join(d, "data");
  process.env.FAKE_HELP = "Usage: codex exec\n  --json\n  --sandbox <mode>";
  let core = await import(`${ROOT_URL}/scripts/codex-core.mjs?j1=${Date.now()}`);
  assert.ok(core.buildArgs({ mode: "ask", cwd: d }).includes("--json"), "--json не добавлен");

  process.env.FAKE_HELP = "Usage: codex exec\n  --sandbox <mode>";
  process.env.CLAUDE_PLUGIN_DATA = path.join(d, "data2");
  core = await import(`${ROOT_URL}/scripts/codex-core.mjs?j2=${Date.now()}`);
  assert.ok(!core.buildArgs({ mode: "ask", cwd: d }).includes("--json"), "--json добавлен без поддержки");
  delete process.env.FAKE_HELP;
});

// ───────────────────────────────── 10. Парсер аргументов setup

await t("10. setup отвергает флаг вместо значения и взаимоисключающие пары", async () => {
  const d = fresh("args");
  const env = { ...process.env, TANDEM_EXPOSED: path.join(d, "e.json"), CODEX_BIN: fakeCodex(d) };
  const run = (a) => spawnSync("node", [`${ROOT}/scripts/setup.mjs`, ...a], { encoding: "utf8", env, cwd: d });

  const r1 = run(["--expose", "tracker", "--tools", "--link-back"]);
  assert.notEqual(r1.status, 0, "флаг принят как значение --tools");

  const r2 = run(["--expose"]);
  assert.notEqual(r2.status, 0, "--expose без значения прошёл");

  const r3 = run(["--wat"]);
  assert.notEqual(r3.status, 0, "неизвестный флаг проигнорирован");

  const r4 = run(["--allow-task", "--deny-task"]);
  assert.notEqual(r4.status, 0, "взаимоисключающая пара выполнена");
});

// ───────────────────────────────── 11. Precedence MCP-серверов

await tExec("11. local имеет приоритет над project и user", async () => {
  const d = fresh("precedence");
  const home = path.join(d, "home");
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(d, "proj", ".claude"), { recursive: true });

  fs.writeFileSync(
    path.join(home, ".claude.json"),
    JSON.stringify({ mcpServers: { srv: { command: "user-command" } } })
  );
  fs.writeFileSync(
    path.join(d, "proj", ".mcp.json"),
    JSON.stringify({ mcpServers: { srv: { command: "project-command" } } })
  );
  fs.writeFileSync(
    path.join(d, "proj", ".claude", "settings.local.json"),
    JSON.stringify({ mcpServers: { srv: { command: "local-command" } } })
  );

  const out = spawnSync(
    "node",
    [
      "-e",
      // Без top-level await: `node -e` разбирает код как CommonJS вплоть до
      // Node 20, и await на верхнем уровне там синтаксическая ошибка.
      `import(${JSON.stringify(`${ROOT}/bridge/tool-proxy.mjs`)}).then((tp) => {
         console.log(JSON.stringify(tp.discoverClaudeServers(${JSON.stringify(path.join(d, "proj"))})));
       });`,
    ],
    { encoding: "utf8", env: { ...process.env, HOME: home }, input: "" }
  );
  const found = JSON.parse((out.stdout || "{}").trim() || "{}");
  assert.equal(found.srv?.command, "local-command", `выбран ${found.srv?.command}`);
});

// ───────────────────────────────── 12. MCP-протокол

await t("12a. сервер не заявляет неподдерживаемую версию протокола", async () => {
  const res = await talk(`${ROOT}/scripts/mcp-image.mjs`, [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2099-01-01" } },
  ]);
  assert.notEqual(res[0].result.protocolVersion, "2099-01-01", "заявлена несуществующая версия");
});

await t("12b. битый JSON даёт parse error, а не молчание", async () => {
  const res = await talkRaw(`${ROOT}/scripts/mcp-image.mjs`, "{ not json\n");
  assert.equal(res[0]?.error?.code, -32700, `получено: ${JSON.stringify(res[0])}`);
});

await t("12c. наружу не уходит stack trace", async () => {
  const res = await talk(`${ROOT}/scripts/mcp-image.mjs`, [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "image_check_params", arguments: {} } },
  ]);
  const body = JSON.stringify(res);
  assert.ok(!/\n\s+at\s+.+:\d+:\d+/.test(body), "в ответе есть stack trace");
});

// ───────────────────────────────── 13. Клиент реагирует на смерть сервера

await t("13. вызов после смерти сервера падает сразу, а не по таймауту", async () => {
  const d = fresh("client-die");
  const srv = path.join(d, "dying.mjs");
  fs.writeFileSync(
    srv,
    `import readline from "node:readline";
const send=m=>process.stdout.write(JSON.stringify(m)+"\\n");
readline.createInterface({input:process.stdin}).on("line",l=>{
  const m=JSON.parse(l);
  if(m.method==="initialize")return send({jsonrpc:"2.0",id:m.id,result:{protocolVersion:"2025-06-18",capabilities:{tools:{}},serverInfo:{name:"d",version:"1"}}});
  if(m.method==="tools/list"){send({jsonrpc:"2.0",id:m.id,result:{tools:[{name:"t",description:"d",inputSchema:{type:"object"}}]}});
    process.stderr.write("умираю по своей причине\\n"); setTimeout(()=>process.exit(3),50); return}
});`
  );
  const { McpStdioClient } = await import(`${ROOT_URL}/bridge/mcp-client.mjs?dc=${Date.now()}`);
  const c = new McpStdioClient({ alias: "dying", command: "node", args: [srv], timeoutMs: 20_000 });
  await c.start();
  await sleep(400);
  const began = Date.now();
  let err = null;
  try {
    await c.call("t", {});
  } catch (e) {
    err = e;
  }
  const took = Date.now() - began;
  assert.ok(err, "ошибка не получена");
  assert.ok(took < 3000, `ждали ${took}мс вместо мгновенного отказа`);
  assert.match(err.message, /умираю|завершил|недоступен/, `stderr потерян: ${err.message}`);
  c.stop();
});

// ───────────────────────────────── вспомогательное: разговор с MCP-сервером

function talkRaw(server, raw, env = {}) {
  return new Promise((resolve) => {
    const c = spawn("node", [server], { env: { ...process.env, ...env } });
    const out = [];
    readline.createInterface({ input: c.stdout }).on("line", (l) => {
      if (l.trim()) {
        try {
          out.push(JSON.parse(l));
        } catch {}
      }
    });
    c.stderr.on("data", () => {});
    c.on("close", () => resolve(out));
    c.stdin.write(raw);
    c.stdin.end();
    setTimeout(() => {
      c.kill();
      resolve(out);
    }, 15_000);
  });
}

function talk(server, msgs, env = {}) {
  return talkRaw(server, msgs.map((m) => JSON.stringify(m)).join("\n") + "\n", env);
}

// ───────────────────────────────── 17. Продолжение треда (codex exec resume)

await t("17a. resume не получает флагов, которых у него нет", async () => {
  const d = fresh("resume-args");
  process.env.CODEX_BIN = fakeCodex(d);
  process.env.CLAUDE_PLUGIN_DATA = path.join(d, "data");
  process.env.FAKE_HELP = "Usage: codex exec\n  --json\n  --sandbox <mode>\n  --ask-for-approval <p>\n  --cd <dir>\n  --skip-git-repo-check";
  const core = await import(`${ROOT_URL}/scripts/codex-core.mjs?ra=${Date.now()}`);

  const id = "019fd169-624d-70f0-8ab9-fcab01aaa476";
  const args = core.buildArgs({ mode: "chat", cwd: d, resume: id, sandbox: "workspace-write" });
  assert.equal(args[0], "exec");
  assert.equal(args[1], "resume", "resume не первый подкомандой");
  for (const flag of ["--sandbox", "--cd", "--ask-for-approval"]) {
    assert.ok(!args.includes(flag), `${flag} передан resume, который его не знает`);
  }
  assert.ok(args.includes(`sandbox_mode="workspace-write"`), `режим песочницы потерян: ${args.join(" ")}`);
  assert.ok(args.includes(`approval_policy="never"`), "политика подтверждений потеряна при записи");
  assert.equal(args[args.length - 1], "-", "промпт не со stdin");
  assert.equal(args[args.length - 2], id, "id треда не перед промптом");
  delete process.env.FAKE_HELP;
});

await t("17b. обычный запуск сохраняет --sandbox и --cd", async () => {
  const d = fresh("resume-args2");
  process.env.CODEX_BIN = fakeCodex(d);
  process.env.CLAUDE_PLUGIN_DATA = path.join(d, "data");
  const core = await import(`${ROOT_URL}/scripts/codex-core.mjs?rb=${Date.now()}`);
  const args = core.buildArgs({ mode: "chat", cwd: d });
  assert.ok(args.includes("--sandbox"), "потерян --sandbox у обычного запуска");
  assert.ok(args.includes("--cd"), "потерян --cd у обычного запуска");
  assert.ok(!args.includes("resume"));
});

await t("17c. сводки размышлений включаются настройкой", async () => {
  const d = fresh("summary");
  process.env.CODEX_BIN = fakeCodex(d);
  process.env.CLAUDE_PLUGIN_DATA = path.join(d, "data");
  process.env.TANDEM_REASONING_SUMMARY = "detailed";
  const core = await import(`${ROOT_URL}/scripts/codex-core.mjs?rs=${Date.now()}`);
  assert.ok(
    core.buildArgs({ mode: "ask", cwd: d }).includes(`model_reasoning_summary="detailed"`),
    "настройка сводок не дошла до Codex"
  );
  delete process.env.TANDEM_REASONING_SUMMARY;
});

// ───────────────────────────────── 18. Воркер задачи вместо /bin/sh

const WORKER = `${ROOT}/scripts/job-worker.mjs`;

/** Запускает воркер на произвольной команде и ждёт код возврата. */
function runWorker(dir, { args, timeoutMs = 0, prompt = "" }) {
  const spec = {
    bin: args ? process.execPath : path.join(dir, "no-such-binary-12345"),
    args: args || [],
    promptFile: path.join(dir, "p"),
    outFile: path.join(dir, "o"),
    codeFile: path.join(dir, "c"),
    noteFile: path.join(dir, "n"),
    cwd: dir,
    timeoutMs,
  };
  fs.writeFileSync(spec.promptFile, prompt);
  const specFile = path.join(dir, "spec.json");
  fs.writeFileSync(specFile, JSON.stringify(spec));
  const child = spawn(process.execPath, [WORKER, specFile], { stdio: "ignore" });
  const read = (f) => {
    try {
      return fs.readFileSync(f, "utf8");
    } catch {
      return null;
    }
  };
  return {
    child,
    spec,
    async settled(waitMs = 15_000) {
      const until = Date.now() + waitMs;
      while (Date.now() < until) {
        const code = read(spec.codeFile);
        if (code !== null) return { code: Number(code), note: read(spec.noteFile), out: read(spec.outFile) || "" };
        await sleep(50);
      }
      return { code: null, note: read(spec.noteFile), out: read(spec.outFile) || "" };
    },
  };
}

await t("18a. воркер работает без /bin/sh и метит события временем", async () => {
  const d = fresh("worker-ok");
  const emit = `process.stdout.write(JSON.stringify({type:"thread.started",thread_id:"t-1"})+"\\n");` +
    `process.stdout.write(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"готово"}})+"\\n");`;
  const w = runWorker(d, { args: ["-e", emit] });
  const r = await w.settled();
  assert.equal(r.code, 0, `код возврата ${r.code}, журнал: ${r.out}`);
  const events = r.out.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(events[0]._ts, "воркер не проставил метку времени: сам Codex её не шлёт");
  assert.equal(events[1].item.text, "готово");
});

await t("18b. отказ запуска — failed с причиной, а не «процесс исчез»", async () => {
  const d = fresh("worker-spawn");
  const w = runWorker(d, { args: null });
  const r = await w.settled();
  assert.equal(r.code, 127, `ожидался 127, получен ${r.code}`);
  assert.equal(r.note, "spawn_failed");
  assert.match(r.out, /could not start Codex/, "причина отказа не попала в журнал");
});

await t("18c. таймаут воркера помечается и убивает процесс", async () => {
  const d = fresh("worker-timeout");
  const w = runWorker(d, { args: ["-e", "setInterval(()=>{},1000)"], timeoutMs: 800 });
  const r = await w.settled();
  assert.equal(r.code, 124, `ожидался 124, получен ${r.code}`);
  assert.equal(r.note, "timeout");
  assert.match(r.out, /task timed out/, "причина таймаута не в журнале");
});

await t("18d. статус задачи берётся из пометки воркера", async () => {
  const d = fresh("note-status");
  process.env.CODEX_BIN = fakeCodex(d);
  process.env.CLAUDE_PLUGIN_DATA = path.join(d, "data");
  const core = await import(`${ROOT_URL}/scripts/codex-core.mjs?ns=${Date.now()}`);
  const jobs = path.join(d, "data", "jobs");
  fs.mkdirSync(jobs, { recursive: true });

  const cases = [
    ["job-aaaa1111", "124", "timeout", "timeout"],
    ["job-bbbb2222", "130", "cancelled", "cancelled"],
    ["job-cccc3333", "127", "spawn_failed", "failed"],
    ["job-dddd4444", "3", null, "failed"],
  ];
  for (const [id, code, note, expected] of cases) {
    fs.writeFileSync(
      path.join(jobs, `${id}.json`),
      JSON.stringify({ id, pid: 999_999, mode: "ask", cwd: d, repo: d, status: "running", startedAt: new Date().toISOString() })
    );
    fs.writeFileSync(path.join(jobs, `${id}.code`), code);
    if (note) fs.writeFileSync(path.join(jobs, `${id}.note`), note);
    assert.equal(core.resolveJob(id, d).status, expected, `${id}: пометка ${note} дала не тот статус`);
  }
});

// ───────────────────────────────── 19. Наблюдение за задачей без блокировки

await t("19. followJob отдаёт события по мере появления и не ждёт вечно", async () => {
  const d = fresh("follow");
  process.env.CODEX_BIN = fakeCodex(d);
  process.env.CLAUDE_PLUGIN_DATA = path.join(d, "data");
  const core = await import(`${ROOT_URL}/scripts/codex-core.mjs?fj=${Date.now()}`);
  const jobs = path.join(d, "data", "jobs");
  fs.mkdirSync(jobs, { recursive: true });
  const id = "job-eeee5555";
  fs.writeFileSync(
    path.join(jobs, `${id}.json`),
    JSON.stringify({ id, pid: 999_999, mode: "ask", cwd: d, repo: d, status: "running", startedAt: new Date().toISOString() })
  );
  const out = path.join(jobs, `${id}.out`);
  fs.writeFileSync(out, "");

  const seen = [];
  const follow = core.followJob(id, { timeoutMs: 8000, onEvent: (e) => seen.push(e.type), pollMs: 50 });
  await sleep(150);
  fs.appendFileSync(out, JSON.stringify({ type: "turn.started" }) + "\n");
  await sleep(200);
  assert.ok(seen.includes("turn.started"), "событие не пришло до завершения задачи");
  fs.appendFileSync(out, JSON.stringify({ type: "turn.completed", usage: {} }) + "\n");
  fs.writeFileSync(path.join(jobs, `${id}.code`), "0");
  const r = await follow;
  assert.equal(r.finished, true, "завершение по коду возврата не распознано");
  assert.equal(r.timedOut, false);

  // Ожидание с истёкшим сроком не убивает задачу и возвращает управление
  fs.writeFileSync(path.join(jobs, `${id}.code`), "0");
  const quick = await core.followJob(id, { timeoutMs: 200, pollMs: 50 });
  assert.equal(quick.finished, true);
});

// ───────────────────────────────── 20. Прогресс и отмена в MCP-транспорте

/** Сервер, шлющий пачку шагов без пауз: часть существенных, часть схлопываемых. */
function burstServer(dir) {
  const p = path.join(dir, "burst.mjs");
  fs.writeFileSync(
    p,
    `import { serve, text } from ${JSON.stringify(`${ROOT_URL}/scripts/mcp-lib.mjs`)};
serve({
  name: "burst",
  tools: [{ name: "work", description: "d", inputSchema: { type: "object", properties: {} } }],
  handle: async (name, args, ctx) => {
    // Без пауз: всё попадает в один интервал троттлинга.
    for (let i = 0; i < 5; i++) {
      ctx.notify("шум " + i);
      ctx.notify("шаг " + i, { keep: true });
    }
    await new Promise((r) => setTimeout(r, 2500));
    return text("DONE");
  },
});
`
  );
  return p;
}

await t("20d. существенные шаги не вытесняют друг друга в пачке", async () => {
  const d = fresh("progress-burst");
  const out = await talk(burstServer(d), [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "work", arguments: {}, _meta: { progressToken: "tok" } } },
  ]);
  const msgs = out.filter((m) => m.method === "notifications/progress").map((n) => n.params.message);

  for (let i = 0; i < 5; i++) {
    assert.ok(msgs.includes(`шаг ${i}`), `существенный шаг ${i} потерян: ${JSON.stringify(msgs)}`);
  }
  // Схлопываемые именно схлопываются, иначе троттлинг перестал работать вовсе.
  const noise = msgs.filter((m) => m.startsWith("шум "));
  assert.ok(noise.length <= 2, `схлопываемые шаги не схлопнулись: ${JSON.stringify(noise)}`);

  const seq = out.filter((m) => m.method === "notifications/progress").map((n) => n.params.progress);
  assert.deepEqual(seq, [...seq].sort((a, b) => a - b), `progress не монотонен: ${seq}`);
});

function progressServer(dir) {
  const p = path.join(dir, "srv.mjs");
  fs.writeFileSync(
    p,
    `import { serve, text } from ${JSON.stringify(`${ROOT_URL}/scripts/mcp-lib.mjs`)};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
serve({
  name: "fixture",
  tools: [{ name: "work", description: "d", inputSchema: { type: "object", properties: {} } }],
  handle: async (name, args, ctx) => {
    for (let i = 0; i < 8; i++) {
      ctx.notify("шаг " + i);
      await sleep(120);
      if (ctx.signal.aborted) return text("ABORTED");
    }
    return text("DONE");
  },
});
`
  );
  return p;
}

await t("20a. прогресс идёт с монотонным счётчиком и только с токеном", async () => {
  const d = fresh("progress");
  const srv = progressServer(d);

  const withToken = await talk(srv, [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "work", arguments: {}, _meta: { progressToken: "tok" } } },
  ]);
  const notes = withToken.filter((m) => m.method === "notifications/progress");
  assert.ok(notes.length >= 2, `уведомлений о прогрессе нет: ${JSON.stringify(withToken).slice(0, 200)}`);
  const seq = notes.map((n) => n.params.progress);
  assert.deepEqual(
    seq,
    [...seq].sort((a, b) => a - b),
    `progress не монотонен: ${seq}`
  );
  assert.ok(notes.every((n) => n.params.progressToken === "tok"), "чужой токен в уведомлении");
  assert.ok(withToken.some((m) => m.id === 2 && m.result), "ответ не пришёл");

  const noToken = await talk(srv, [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "work", arguments: {} } },
  ]);
  assert.equal(
    noToken.filter((m) => m.method === "notifications/progress").length,
    0,
    "уведомления без progressToken: их некуда адресовать"
  );
});

await t("20c. лента прогресса выключается настройкой", async () => {
  const d = fresh("progress-off");
  const srv = progressServer(d);
  // Известный дефект части сборок Claude Code: получение notifications/progress
  // закрывает соединение (anthropics/claude-code#47378). Выключатель нужен,
  // чтобы это лечилось настройкой, а не правкой кода.
  const out = await talk(
    srv,
    [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "work", arguments: {}, _meta: { progressToken: "tok" } } },
    ],
    { TANDEM_PROGRESS: "false" }
  );
  assert.equal(out.filter((m) => m.method === "notifications/progress").length, 0, "уведомления идут при выключенной ленте");
  assert.ok(out.some((m) => m.id === 2 && m.result), "сам вызов перестал отвечать");
});

await t("20b. отмена доходит до обработчика и ответ не отправляется", async () => {
  const d = fresh("cancel-mcp");
  const srv = progressServer(d);
  const msgs = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "work", arguments: {} } },
    { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 2, reason: "user" } },
  ];
  const out = await talk(srv, msgs);
  assert.ok(!out.some((m) => m.id === 2), `на отменённый вызов пришёл ответ: ${JSON.stringify(out)}`);
});

// ───────────────────────────────── 21. Состояние разговоров

await t("21a. имя чата проверяется, обход каталога невозможен", async () => {
  const d = fresh("chat-slug");
  process.env.CODEX_BIN = fakeCodex(d);
  process.env.CLAUDE_PLUGIN_DATA = path.join(d, "data");
  const store = await import(`${ROOT_URL}/scripts/chat-store.mjs?cs=${Date.now()}`);
  for (const bad of ["../evil", "a/b", "", ".hidden", "x".repeat(60), "a b"]) {
    assert.equal(store.isValidSlug(bad), false, `принято недопустимое имя: ${JSON.stringify(bad)}`);
    assert.equal(store.readChat(bad), null, `прочитан чат по недопустимому имени: ${bad}`);
  }
  assert.ok(store.isValidSlug("default"));
  assert.ok(store.isValidSlug("gpt-5.6-sol"));
});

await t("21b. параллельный ход по одному треду блокируется", async () => {
  const d = fresh("chat-lock");
  process.env.CODEX_BIN = fakeCodex(d);
  process.env.CLAUDE_PLUGIN_DATA = path.join(d, "data");
  const store = await import(`${ROOT_URL}/scripts/chat-store.mjs?cl=${Date.now()}`);

  let released = false;
  const first = store.withChatLock("t", async () => {
    await sleep(1500);
    released = true;
    return "ok";
  });
  await sleep(150);
  let busy = null;
  try {
    await store.withChatLock("t", async () => "второй");
  } catch (e) {
    busy = e;
  }
  assert.ok(busy?.busy, "второй ход не был отклонён — треды перепишут друг друга");
  assert.equal(released, false, "первый ход успел завершиться, проверка бессмысленна");
  assert.equal(await first, "ok");
  // Замок снят — следующий ход проходит
  assert.equal(await store.withChatLock("t", async () => "третий"), "третий");
});

await t("21c. чат хранит модель, effort и тред между ходами", async () => {
  const d = fresh("chat-state");
  process.env.CODEX_BIN = fakeCodex(d);
  process.env.CLAUDE_PLUGIN_DATA = path.join(d, "data");
  const store = await import(`${ROOT_URL}/scripts/chat-store.mjs?ct=${Date.now()}`);
  store.writeChat({ slug: "a", model: "m-one", effort: "high", threadId: "t-1", cwd: d, turns: 1, updatedAt: new Date().toISOString() });
  const c = store.readChat("a");
  assert.equal(c.model, "m-one");
  assert.equal(c.effort, "high");
  assert.equal(c.threadId, "t-1");
  assert.ok(store.listChats(d).some((x) => x.slug === "a"));
  assert.ok(store.deleteChat("a"));
  assert.equal(store.readChat("a"), null);
});

await t("21d. модель по умолчанию хранится по репозиторию и сбрасывается", async () => {
  const d = fresh("prefs");
  process.env.CODEX_BIN = fakeCodex(d);
  process.env.CLAUDE_PLUGIN_DATA = path.join(d, "data");
  const prefs = await import(`${ROOT_URL}/scripts/prefs.mjs?pf=${Date.now()}`);
  prefs.writePrefs("/repo/a", { model: "m-one", effort: "high" });
  prefs.writePrefs("/repo/b", { model: "m-two" });
  assert.equal(prefs.readPrefs("/repo/a").model, "m-one");
  assert.equal(prefs.readPrefs("/repo/b").model, "m-two", "значения репозиториев смешались");
  assert.equal(prefs.readPrefs("/repo/b").effort, null);
  prefs.writePrefs("/repo/a", { model: null, effort: null });
  assert.equal(prefs.readPrefs("/repo/a").model, null, "сброс не сработал");
});

// ───────────────────────────────── 22. Нормализация событий

await t("22a. сводка размышлений не обрезается до первой строки", async () => {
  const ev = await import(`${ROOT_URL}/scripts/codex-events.mjs?n1=${Date.now()}`);
  const long = "Первая строка размышления\n" + "далее подробности ".repeat(30);
  const n = ev.normalize({ type: "item.completed", item: { type: "reasoning", text: long } });
  assert.equal(n.kind, "reasoning");
  assert.ok(n.title.length < 200, "в ленте не короткая строка");
  assert.ok(n.detail.length > 300, `сводка урезана до ${n.detail.length} символов`);
  assert.ok(n.detail.includes("далее подробности"), "потеряно содержимое сводки");
});

await t("22b. нормализуются все типы item, которые шлёт Codex", async () => {
  const ev = await import(`${ROOT_URL}/scripts/codex-events.mjs?n2=${Date.now()}`);
  const cases = [
    [{ type: "thread.started", thread_id: "t-9" }, "status"],
    [{ type: "item.completed", item: { type: "reasoning", text: "думаю" } }, "reasoning"],
    [{ type: "item.started", item: { type: "command_execution", command: "ls" } }, "command"],
    [{ type: "item.completed", item: { type: "file_change", changes: [{ path: "a.ts", kind: "modify" }] } }, "file"],
    [{ type: "item.completed", item: { type: "mcp_tool_call", server: "s", tool: "t" } }, "mcp"],
    [{ type: "item.started", item: { type: "web_search", query: "q" } }, "web"],
    [{ type: "item.completed", item: { type: "todo_list", items: [{ text: "a", completed: true }] } }, "todo"],
    [{ type: "item.completed", item: { type: "collab_tool_call", tool: "sub" } }, "mcp"],
    [{ type: "item.completed", item: { type: "agent_message", text: "ответ" } }, "message"],
    [{ type: "item.completed", item: { type: "error", message: "мелкая беда" } }, "error"],
    [{ type: "turn.failed", error: { message: "конец" } }, "error"],
  ];
  for (const [e, kind] of cases) {
    const n = ev.normalize(e);
    assert.ok(n, `событие не нормализовано: ${JSON.stringify(e)}`);
    assert.equal(n.kind, kind, `${JSON.stringify(e)} → ${n.kind}, ожидалось ${kind}`);
    assert.ok(n.title, "пустая строка ленты");
  }
  assert.equal(ev.threadIdOf([{ type: "thread.started", thread_id: "t-9" }]), "t-9");
});

await t("22c. чужой вывод не утекает в ленту целиком", async () => {
  const ev = await import(`${ROOT_URL}/scripts/codex-events.mjs?n3=${Date.now()}`);
  const secret = "ключ-" + "x".repeat(9000);
  const n = ev.normalize({
    type: "item.completed",
    item: { type: "mcp_tool_call", server: "s", tool: "t", arguments: { token: secret }, result: secret },
  });
  assert.ok(!JSON.stringify(n).includes(secret), "аргументы и результат чужого инструмента ушли наружу");

  const big = ev.normalize({
    type: "item.completed",
    item: { type: "command_execution", command: "cat big", aggregated_output: "z".repeat(50_000), exit_code: 0 },
  });
  assert.ok(big.detail.length < 5000, `вывод команды не усечён: ${big.detail.length}`);
});

// ───────────────────────────────── 23. Обратный мост: асинхронность и отмена

/** Заглушка claude: спит, отмечается в файле и печатает ответ. */
function fakeClaude(dir, { sleepMs = 0, marker = null } = {}) {
  const p = path.join(dir, "claude");
  fs.writeFileSync(
    p,
    `#!/usr/bin/env node
const fs=require("fs");
${marker ? `fs.writeFileSync(${JSON.stringify(marker)}+"."+process.pid,"started");` : ""}
setTimeout(()=>{${marker ? `fs.writeFileSync(${JSON.stringify(marker)}+"."+process.pid,"finished");` : ""}console.log("ответ claude");process.exit(0)},${sleepMs});`,
    { mode: 0o755 }
  );
  return p;
}

await tExec("23a. вызовы обратного моста идут параллельно, а не по очереди", async () => {
  const d = fresh("reverse-parallel");
  const exposed = path.join(d, "exposed.json");
  fs.writeFileSync(exposed, JSON.stringify({ servers: {}, allow_task: false }));

  const started = Date.now();
  const res = await talk(
    `${ROOT}/bridge/mcp-claude.mjs`,
    [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "claude_ask", arguments: { question: "a" } } },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "claude_ask", arguments: { question: "b" } } },
    ],
    { CLAUDE_BIN: fakeClaude(d, { sleepMs: 1500 }), TANDEM_EXPOSED: exposed }
  );
  const elapsed = Date.now() - started;

  assert.ok(res.find((m) => m.id === 2)?.result, "первый вызов без ответа");
  assert.ok(res.find((m) => m.id === 3)?.result, "второй вызов без ответа");
  // Последовательный spawnSync дал бы не меньше 3000 мс на два вызова по 1500.
  assert.ok(elapsed < 2600, `вызовы сериализовались: ${elapsed} мс на два по 1500`);
});

await tExec("23b. ping доходит, пока обратный мост занят вызовом", async () => {
  const d = fresh("reverse-ping");
  const exposed = path.join(d, "exposed.json");
  fs.writeFileSync(exposed, JSON.stringify({ servers: {}, allow_task: false }));

  const res = await talk(
    `${ROOT}/bridge/mcp-claude.mjs`,
    [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "claude_ask", arguments: { question: "a" } } },
      { jsonrpc: "2.0", id: 3, method: "ping" },
    ],
    { CLAUDE_BIN: fakeClaude(d, { sleepMs: 1200 }), TANDEM_EXPOSED: exposed }
  );

  const ping = res.findIndex((m) => m.id === 3);
  const call = res.findIndex((m) => m.id === 2);
  assert.ok(ping >= 0, "на ping не ответили — event loop заблокирован");
  assert.ok(ping < call, "ping ответил только после вызова: сервер был заблокирован");
});

await tExec("23c. отмена одного вызова не трогает другой", async () => {
  const d = fresh("reverse-cancel");
  const exposed = path.join(d, "exposed.json");
  fs.writeFileSync(exposed, JSON.stringify({ servers: {}, allow_task: false }));
  const marker = path.join(d, "mark");

  const res = await talk(
    `${ROOT}/bridge/mcp-claude.mjs`,
    [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "claude_ask", arguments: { question: "a" } } },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "claude_ask", arguments: { question: "b" } } },
      { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 2 } },
    ],
    { CLAUDE_BIN: fakeClaude(d, { sleepMs: 1500, marker }), TANDEM_EXPOSED: exposed }
  );

  assert.ok(!res.some((m) => m.id === 2), "на отменённый вызов пришёл ответ");
  assert.ok(res.find((m) => m.id === 3)?.result, "отмена унесла с собой соседний вызов");

  const marks = fs.readdirSync(d).filter((f) => f.startsWith("mark."));
  const finished = marks.filter((f) => fs.readFileSync(path.join(d, f), "utf8") === "finished");
  assert.equal(finished.length, 1, `дожить должен ровно один процесс, дожило ${finished.length}`);
});

// ───────────────────────────────── 24. Проверка готовности Codex

await t("24a. параллельные проверки готовности не плодят процессов", async () => {
  const d = fresh("probe-single");
  process.env.CODEX_BIN = process.execPath; // node: --version отвечает мгновенно
  process.env.CLAUDE_PLUGIN_DATA = path.join(d, "data");
  const core = await import(`${ROOT_URL}/scripts/codex-core.mjs?pr=${Date.now()}`);

  const [a, b] = await Promise.all([core.probeCodex(), core.probeCodex()]);
  assert.strictEqual(a, b, "две параллельные проверки запустили две разные");

  const cached = await core.probeCodex();
  assert.strictEqual(cached, a, "результат не кэшируется, проверка идёт на каждый вызов");

  const forced = await core.probeCodex({ force: true });
  assert.notStrictEqual(forced, a, "force не обходит кэш");
  delete process.env.CODEX_BIN;
});

await tExec("24b. зависшая проверка даёт probe_timeout, а не «не установлен»", async () => {
  const d = fresh("probe-hang");
  const bin = path.join(d, "codex");
  fs.writeFileSync(bin, "#!/usr/bin/env node\nsetTimeout(()=>process.exit(0),60000);\n", { mode: 0o755 });
  process.env.CODEX_BIN = bin;
  process.env.CLAUDE_PLUGIN_DATA = path.join(d, "data");
  const core = await import(`${ROOT_URL}/scripts/codex-core.mjs?ph=${Date.now()}`);

  const started = Date.now();
  const r = await core.probeCodex();
  const elapsed = Date.now() - started;

  assert.equal(r.reason, "probe_timeout", `зависший бинарь опознан как ${r.reason}`);
  assert.ok(elapsed < 8000, `проверка висела ${elapsed} мс вместо таймаута`);
  delete process.env.CODEX_BIN;
});

await t("24c. инструментам без запуска Codex проверка готовности не нужна", async () => {
  const d = fresh("probe-skip");
  const res = await talk(
    `${ROOT}/scripts/mcp-codex.mjs`,
    [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "codex_status", arguments: {} } },
    ],
    { CODEX_BIN: path.join(d, "codex-которого-нет"), CLAUDE_PLUGIN_DATA: path.join(d, "data") }
  );

  const call = res.find((m) => m.id === 2);
  assert.ok(call?.result, "codex_status не ответил");
  assert.ok(
    !/не найден/.test(call.result.content[0].text),
    "codex_status требует установленного Codex, хотя лишь читает состояние с диска"
  );
});

// ───────────────────────────────── 25. Сбор контекста для ревью

/** Временный репозиторий с одним коммитом на main. */
function repo(name) {
  const d = fresh(name);
  const g = (...a) =>
    spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...a], {
      cwd: d,
      encoding: "utf8",
    });
  g("init", "-b", "main");
  fs.writeFileSync(path.join(d, "base.txt"), "начало\n");
  g("add", "-A");
  g("commit", "-m", "первый");
  return { dir: d, g };
}

await t("25a. с base собираются и коммиты ветки, и незакоммиченное", async () => {
  const { dir, g } = repo("diff-both");
  g("checkout", "-b", "feature");
  fs.writeFileSync(path.join(dir, "committed.txt"), "в коммите\n");
  g("add", "-A");
  g("commit", "-m", "правка в ветке");
  fs.appendFileSync(path.join(dir, "base.txt"), "правка в рабочем дереве\n");

  const core = await import(`${ROOT_URL}/scripts/codex-core.mjs?d1=${Date.now()}`);
  const out = core.collectDiff(dir, "main");

  assert.match(out, /committed\.txt/, "коммиты ветки не собраны");
  assert.match(out, /правка в рабочем дереве/, "незакоммиченное не собрано");
  assert.match(out, /Not committed yet/, "разделы не размечены");
});

await t("25b. новый файл показывается содержимым, а не одним именем", async () => {
  const { dir } = repo("diff-untracked");
  fs.writeFileSync(path.join(dir, "new.js"), "export const answer = 42;\n");

  const core = await import(`${ROOT_URL}/scripts/codex-core.mjs?d2=${Date.now()}`);
  const out = core.collectDiff(dir, null);
  assert.match(out, /answer = 42/, "содержимое нового файла потеряно, передано только имя");
});

await t("25c. секреты и двоичные файлы содержимым не вкладываются", async () => {
  const { dir } = repo("diff-secrets");
  fs.writeFileSync(path.join(dir, ".env"), "API_KEY=sk-очень-секретно\n");
  fs.writeFileSync(path.join(dir, "server.key"), "-----BEGIN PRIVATE KEY-----\nтайна\n");
  fs.writeFileSync(path.join(dir, "blob.bin"), Buffer.from([0, 1, 2, 0, 3]));
  fs.writeFileSync(path.join(dir, "ok.txt"), "видимый текст\n");

  const core = await import(`${ROOT_URL}/scripts/codex-core.mjs?d3=${Date.now()}`);
  const out = core.collectDiff(dir, null);

  assert.ok(!out.includes("sk-очень-секретно"), "содержимое .env ушло в промпт");
  assert.ok(!out.includes("BEGIN PRIVATE KEY"), "содержимое ключа ушло в промпт");
  assert.match(out, /\.env/, "про .env не сказано вовсе");
  assert.match(out, /binary/, "двоичный файл не помечен");
  assert.match(out, /видимый текст/, "обычный файл перестал вкладываться");
});

await t("25d. непонятная база отклоняется, а не даёт пустой диф", async () => {
  const { dir } = repo("diff-badbase");
  const core = await import(`${ROOT_URL}/scripts/codex-core.mjs?d4=${Date.now()}`);
  assert.throws(
    () => core.collectDiff(dir, "такой-ветки-нет"),
    /does not resolve to a commit/,
    "несуществующая база принята молча"
  );
});

await t("25e. вне git-репозитория ревью отказывает явно", async () => {
  const d = fresh("diff-norepo");
  const core = await import(`${ROOT_URL}/scripts/codex-core.mjs?d5=${Date.now()}`);
  assert.throws(() => core.collectDiff(d, null), /not a git repository/, "отсутствие репозитория не замечено");
});

await t("25f. большой диф не обрезается, а передаётся сводкой", async () => {
  const { dir, g } = repo("diff-big");
  for (let i = 0; i < 80; i++) fs.writeFileSync(path.join(dir, `f${i}.txt`), `файл ${i}\n`);
  g("add", "-A");

  const core = await import(`${ROOT_URL}/scripts/codex-core.mjs?d6=${Date.now()}`);
  const out = core.collectDiff(dir, null);

  assert.ok(!/\[\.\.\. диф обрезан/.test(out), "патч всё ещё обрезается посередине");
  assert.match(out, /Read the parts you need yourself/, "нет указания дочитать самому");
  assert.match(out, /Files changed: 80/, "нет сводки по числу файлов");
});

await t("25g. чужой diff.external не подменяет формат дифа", async () => {
  const { dir, g } = repo("diff-external");
  // Подменённый драйвер печатает мусор вместо патча. Без --no-ext-diff
  // ревью получило бы его вывод вместо изменений.
  g("config", "diff.external", "echo ЧУЖОЙ-ДРАЙВЕР");
  fs.appendFileSync(path.join(dir, "base.txt"), "новая строка\n");

  const core = await import(`${ROOT_URL}/scripts/codex-core.mjs?d7=${Date.now()}`);
  const out = core.collectDiff(dir, null);
  assert.ok(!out.includes("ЧУЖОЙ-ДРАЙВЕР"), "внешний diff-драйвер подменил патч");
  assert.match(out, /новая строка/, "настоящий патч потерян");
});

await tExec("25h. символическая ссылка не разыменовывается", async () => {
  process.env.TANDEM_LANG = "ru";
  const { dir } = repo("diff-symlink");
  const outside = path.join(TMP, "чужой-секрет.txt");
  fs.writeFileSync(outside, "СОДЕРЖИМОЕ ЗА ПРЕДЕЛАМИ РЕПОЗИТОРИЯ");
  fs.symlinkSync(outside, path.join(dir, "link.txt"));

  const core = await import(`${ROOT_URL}/scripts/codex-core.mjs?d8=${Date.now()}`);
  const out = core.collectDiff(dir, null);
  assert.ok(!out.includes("СОДЕРЖИМОЕ ЗА ПРЕДЕЛАМИ"), "по симлинку прочитан файл вне репозитория");
  assert.match(out, /символическая ссылка/, "симлинк не помечен");
  delete process.env.TANDEM_LANG;
});

// ───────────────────────────────── 26. Предел одновременных задач

/**
 * Живой процесс-пустышка. Свой pid сюда подставлять нельзя: reconcile убивает
 * просроченные задачи, и тест застрелил бы сам себя.
 */
function victim() {
  const c = spawn(process.execPath, ["-e", "setTimeout(()=>{},60000)"], { stdio: "ignore" });
  c.unref();
  return c;
}

/** Задача в сторе, чей процесс заведомо жив. */
function fakeLiveJob(dataRoot, id, { pid, ageMs = 0 } = {}) {
  const dir = path.join(dataRoot, "jobs");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${id}.json`),
    JSON.stringify({
      id,
      pid,
      mode: "delegate",
      label: "занятая задача",
      cwd: dataRoot,
      repo: dataRoot,
      status: "running",
      exitCode: null,
      startedAt: new Date(Date.now() - ageMs).toISOString(),
      finishedAt: null,
    })
  );
}

await t("26a. предел одновременных задач не пробивается", async () => {
  const d = fresh("limit-hit");
  const data = path.join(d, "data");
  process.env.CLAUDE_PLUGIN_DATA = data;
  process.env.CODEX_BIN = path.join(d, "codex-которого-нет");
  process.env.TANDEM_MAX_PARALLEL_JOBS = "1";
  const v1 = victim();
  fakeLiveJob(data, "job-aaaaaaaa", { pid: v1.pid });

  const core = await import(`${ROOT_URL}/scripts/codex-core.mjs?l1=${Date.now()}`);
  assert.equal(core.liveJobs().length, 1, "живая задача не посчитана");

  let caught = null;
  try {
    core.startJob({ mode: "delegate", task: "вторая", cwd: d, prompt: "x" });
  } catch (e) {
    caught = e;
  }
  assert.ok(caught, "вторая задача запустилась при пределе 1");
  assert.equal(caught.busy, true, "отказ не помечен как «занято»");
  assert.match(caught.message, /job-aaaaaaaa/, "в отказе не перечислены живые задачи");

  const created = fs.readdirSync(path.join(data, "jobs")).filter((f) => f.endsWith(".json"));
  assert.equal(created.length, 1, "отклонённая задача всё же оставила след в хранилище");
  v1.kill();
  delete process.env.TANDEM_MAX_PARALLEL_JOBS;
});

await t("26b. нулевой предел снимает ограничение", async () => {
  const d = fresh("limit-off");
  const data = path.join(d, "data");
  process.env.CLAUDE_PLUGIN_DATA = data;
  process.env.CODEX_BIN = path.join(d, "codex-которого-нет");
  process.env.TANDEM_MAX_PARALLEL_JOBS = "0";
  const v2 = victim();
  fakeLiveJob(data, "job-bbbbbbbb", { pid: v2.pid });

  const core = await import(`${ROOT_URL}/scripts/codex-core.mjs?l2=${Date.now()}`);
  const job = core.startJob({ mode: "delegate", task: "вторая", cwd: d, prompt: "x" });
  assert.ok(job?.id, "при нулевом пределе задача не запустилась");
  v2.kill();
  delete process.env.TANDEM_MAX_PARALLEL_JOBS;
});

await t("26c. задача, висящая дольше двойного таймаута, живой не считается", async () => {
  const d = fresh("limit-stale");
  const data = path.join(d, "data");
  process.env.CLAUDE_PLUGIN_DATA = data;
  process.env.CODEX_BIN = path.join(d, "codex-которого-нет");
  process.env.TANDEM_JOB_TIMEOUT_MIN = "1";
  // Три минуты при таймауте в одну: воркер убил бы её давно, значит под этим
  // pid работает уже чужой процесс.
  const v3 = victim();
  fakeLiveJob(data, "job-cccccccc", { pid: v3.pid, ageMs: 3 * 60_000 });

  const core = await import(`${ROOT_URL}/scripts/codex-core.mjs?l3=${Date.now()}`);
  assert.equal(core.liveJobs().length, 0, "переиспользованный pid принят за живую задачу");
  try { v3.kill(); } catch {}
  delete process.env.TANDEM_JOB_TIMEOUT_MIN;
});

await tExec("26d. предел выдерживается при одновременном запуске из двух процессов", async () => {
  const d = fresh("limit-race");
  const data = path.join(d, "data");
  fs.writeFileSync(path.join(d, "codex"), "#!/usr/bin/env node\nsetTimeout(()=>process.exit(0),30000);\n", {
    mode: 0o755,
  });

  const starter = path.join(d, "start.mjs");
  fs.writeFileSync(
    starter,
    `import { startJob } from ${JSON.stringify(`${ROOT_URL}/scripts/codex-core.mjs`)};
try {
  const j = startJob({ mode: "delegate", task: "гонка", cwd: ${JSON.stringify(d)}, prompt: "x" });
  console.log("STARTED " + j.id);
} catch (e) {
  console.log(e?.busy ? "BUSY" : "ERROR " + (e?.message || e));
}`
  );

  const env = {
    ...process.env,
    CLAUDE_PLUGIN_DATA: data,
    CODEX_BIN: path.join(d, "codex"),
    TANDEM_MAX_PARALLEL_JOBS: "1",
  };
  const run = () =>
    new Promise((resolve) => {
      const c = spawn(process.execPath, [starter], { env });
      let out = "";
      c.stdout.on("data", (b) => (out += b));
      c.on("close", () => resolve(out.trim()));
    });

  const results = await Promise.all([run(), run(), run()]);
  const started = results.filter((r) => r.startsWith("STARTED"));
  const busy = results.filter((r) => r === "BUSY");

  assert.equal(started.length, 1, `при пределе 1 запустилось ${started.length}: ${results.join(" | ")}`);
  assert.equal(busy.length, 2, `отказов «занято» ${busy.length}: ${results.join(" | ")}`);

  for (const line of started) {
    const id = line.split(" ")[1];
    const job = JSON.parse(fs.readFileSync(path.join(data, "jobs", `${id}.json`), "utf8"));
    try {
      process.kill(job.pid, "SIGKILL");
    } catch {}
  }
});

// ───────────────────────────────── 27. Версия из единственного источника

await t("28. версия MCP-серверов берётся из манифеста, а не из строки в коде", async () => {
  const { pluginVersion } = await import(`${ROOT_URL}/scripts/version.mjs?v=${Date.now()}`);
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, ".claude-plugin", "plugin.json"), "utf8"));
  assert.equal(pluginVersion(), manifest.version, "версия разошлась с манифестом");

  // Три сервера и MCP-клиент раньше несли версию строкой и разъехались:
  // plugin.json 0.4.1, claude-bridge 0.3.0, остальные — дефолт 0.1.0.
  for (const f of ["scripts/mcp-codex.mjs", "scripts/mcp-image.mjs", "bridge/mcp-claude.mjs", "bridge/mcp-client.mjs"]) {
    const src = fs.readFileSync(path.join(ROOT, f), "utf8");
    assert.ok(/pluginVersion\(\)/.test(src), `${f} не берёт версию из манифеста`);
    assert.ok(!/version:\s*"\d+\.\d+\.\d+"/.test(src), `${f} снова несёт версию строкой`);
  }
});

await t("29. у каждой команды объявлен свой набор инструментов", async () => {
  const dir = path.join(ROOT, "commands");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
  assert.ok(files.length >= 14, `команд найдено ${files.length}`);

  for (const f of files) {
    // Переводы строк нормализуются: часть файлов в репозитории с CRLF.
    const src = fs.readFileSync(path.join(dir, f), "utf8").replace(/\r\n/g, "\n");
    const fm = /^---\n([\s\S]*?)\n---/.exec(src);
    assert.ok(fm, `${f}: нет frontmatter`);
    const line = /^allowed-tools:\s*(.+)$/m.exec(fm[1]);
    assert.ok(line, `${f}: нет allowed-tools — подтверждения снимаются неявно`);
    assert.ok(line[1].trim().length > 0, `${f}: allowed-tools пуст`);
  }
});

// ───────────────────────────────── 30. Язык описаний и промптов

await t("30a. по умолчанию промпты и описания уходят на английском", async () => {
  delete process.env.TANDEM_LANG;
  const i18n = await import(`${ROOT_URL}/scripts/i18n.mjs?en=${Date.now()}`);
  assert.equal(i18n.lang(), "en");
  assert.match(i18n.prompt("ask", "why?"), /second opinion/, "промпт не на английском");
  assert.match(i18n.toolText().ask_d, /Ask GPT/, "описание инструмента не на английском");
});

await t("30b. настройка переключает язык, неизвестное значение игнорируется", async () => {
  process.env.TANDEM_LANG = "ru";
  const ru = await import(`${ROOT_URL}/scripts/i18n.mjs?ru=${Date.now()}`);
  assert.equal(ru.lang(), "ru");
  assert.match(ru.prompt("ask", "почему?"), /второе мнение/, "русский промпт не подставился");
  assert.match(ru.toolText().ask_d, /Спросить у GPT/, "русское описание не подставилось");

  process.env.TANDEM_LANG = "klingon";
  assert.equal(ru.lang(), "en", "неизвестный язык не откатился к английскому");
  delete process.env.TANDEM_LANG;
});

await t("30c. недостающий перевод не оставляет описание пустым", async () => {
  const stamp = Date.now();
  const core = await import(`${ROOT_URL}/scripts/i18n.mjs?fb=${stamp}`);
  const runtime = await import(`${ROOT_URL}/scripts/i18n-runtime.mjs?fb=${stamp}`);
  const image = await import(`${ROOT_URL}/scripts/i18n-image.mjs?fb=${stamp}`);
  const claude = await import(`${ROOT_URL}/bridge/i18n-claude.mjs?fb=${stamp}`);

  // Таблицы читаются на каждый вызов, поэтому язык переключается переменной.
  const both = (fn) => {
    delete process.env.TANDEM_LANG;
    const en = fn();
    process.env.TANDEM_LANG = "ru";
    const ru = fn();
    delete process.env.TANDEM_LANG;
    return { en, ru };
  };

  const tables = [
    ["i18n.toolText", () => core.toolText()],
    ["i18n.uiText", () => core.uiText()],
    ["i18n.coreText", () => core.coreText()],
    ["i18n.trailText", () => core.trailText()],
    ["i18n-image.toolText", () => image.toolText()],
    ["i18n-claude.toolText", () => claude.toolText()],
  ];

  for (const [name, fn] of tables) {
    const { en, ru } = both(fn);
    assert.ok(Object.keys(en).length, `${name}: английская таблица пуста`);
    for (const key of Object.keys(en)) {
      assert.ok(ru[key] !== undefined && ru[key] !== "", `${name}: ключ ${key} пуст при русском языке`);
    }
  }

  // Модули сообщений отдают строку по ключу — проверяем сам механизм отката.
  assert.equal(typeof runtime.message("preflight_not_installed"), "string");
});

await t("30d. команды и агенты остаются на английском", async () => {
  const cyr = /[Ѐ-ӿ]/;
  for (const dir of ["commands", "agents"]) {
    for (const f of fs.readdirSync(path.join(ROOT, dir))) {
      const src = fs.readFileSync(path.join(ROOT, dir, f), "utf8");
      assert.ok(!cyr.test(src), `${dir}/${f}: остался русский текст — переключателя языка у статических файлов нет`);
    }
  }
});

// ───────────────────────────────── 31. Нативное ревью через app-server

await t("31a. backend ревью выбирается настройкой, exec остаётся по умолчанию", async () => {
  delete process.env.TANDEM_REVIEW_BACKEND;
  const core = await import(`${ROOT_URL}/scripts/codex-core.mjs?rb=${Date.now()}`);
  assert.equal(core.reviewBackend(), "exec");
  process.env.TANDEM_REVIEW_BACKEND = "app-server";
  assert.equal(core.reviewBackend(), "app-server");
  process.env.TANDEM_REVIEW_BACKEND = "неизвестный";
  assert.equal(core.reviewBackend(), "exec", "неизвестное значение не откатилось к безопасному backend");
  delete process.env.TANDEM_REVIEW_BACKEND;

  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, ".claude-plugin", "plugin.json"), "utf8"));
  assert.equal(manifest.userConfig.review_backend.default, "exec");
  const mcp = JSON.parse(fs.readFileSync(path.join(ROOT, ".mcp.json"), "utf8"));
  assert.equal(mcp.mcpServers.codex.env.TANDEM_REVIEW_BACKEND, "${user_config.review_backend}");
});

await t("31b. отказ app-server до принятия review/start запускает exec fallback", async () => {
  const d = fresh("app-fallback");
  const app = await import(`${ROOT_URL}/scripts/app-server.mjs?fb=${Date.now()}`);
  let fallbacks = 0;
  const r = await app.runAppServerReviewWithFallback(
    { cwd: d, command: fakeAppServer(d, "reject"), target: { type: "uncommittedChanges" } },
    async () => ({ backend: "exec", count: ++fallbacks })
  );
  assert.deepEqual(r, { backend: "exec", count: 1 });
});

await t("31c. после принятия review/start exec повторно не запускается", async () => {
  const d = fresh("app-no-repeat");
  const app = await import(`${ROOT_URL}/scripts/app-server.mjs?nr=${Date.now()}`);
  let fallbacks = 0;
  await assert.rejects(
    app.runAppServerReviewWithFallback(
      { cwd: d, command: fakeAppServer(d, "fail"), target: { type: "uncommittedChanges" } },
      async () => ({ backend: "exec", count: ++fallbacks })
    ),
    (error) => error.reviewAccepted === true && /review failed/.test(error.message)
  );
  assert.equal(fallbacks, 0, "после принятого review/start запущен второй расход квоты");
});

await t("31d. смерть app-server в середине ревью немедленно завершает задачу отказом", async () => {
  const d = fresh("app-death");
  const app = await import(`${ROOT_URL}/scripts/app-server.mjs?death=${Date.now()}`);
  let fallbacks = 0;
  const started = Date.now();
  await assert.rejects(
    app.runAppServerReviewWithFallback(
      { cwd: d, command: fakeAppServer(d, "exit"), target: { type: "uncommittedChanges" }, requestTimeoutMs: 5_000 },
      async () => ({ backend: "exec", count: ++fallbacks })
    ),
    (error) => error.reviewAccepted === true && /exited|closed/i.test(error.message)
  );
  assert.ok(Date.now() - started < 2_000, "смерть процесса обнаружена только по таймауту");
  assert.equal(fallbacks, 0);
});

await t("31e. отмена принятого ревью отправляет turn/interrupt с точными id", async () => {
  const d = fresh("app-cancel");
  const log = path.join(d, "rpc.jsonl");
  process.env.FAKE_APP_LOG = log;
  const app = await import(`${ROOT_URL}/scripts/app-server.mjs?cancel=${Date.now()}`);
  const controller = new AbortController();
  const r = await app.runAppServerReview({
    cwd: d,
    command: fakeAppServer(d, "cancel"),
    target: { type: "uncommittedChanges" },
    signal: controller.signal,
    onAccepted: () => controller.abort(),
  });
  delete process.env.FAKE_APP_LOG;

  assert.equal(r.cancelled, true);
  const messages = fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
  const interrupt = messages.find((message) => message.method === "turn/interrupt");
  assert.deepEqual(interrupt?.params, { threadId: "thread-1", turnId: "turn-1" });
});

await t("31f. уведомления app-server нормализуются в прежний JSONL-формат", async () => {
  const ev = await import(`${ROOT_URL}/scripts/codex-events.mjs?app=${Date.now()}`);
  const review = ev.fromAppServerNotification({
    method: "item/completed",
    params: { threadId: "thread-1", turnId: "turn-1", item: { type: "exitedReviewMode", review: "native result" } },
  });
  const tool = ev.fromAppServerNotification({
    method: "item/started",
    params: { threadId: "thread-1", turnId: "turn-1", item: { type: "mcpToolCall", server: "fake", tool: "read" } },
  });
  const log = [review, { type: "turn.completed" }].map(JSON.stringify).join("\n");
  assert.equal(ev.extractOutput(log).text, "native result");
  assert.match(ev.normalize(tool).title, /fake\/read/);
});

await t("31g. app-server ревью проходит через detached worker и читается после перезапуска MCP", async () => {
  const d = fresh("app-worker");
  process.env.CLAUDE_PLUGIN_DATA = path.join(d, "data");
  const command = fakeAppServer(d, "complete");
  const core = await import(`${ROOT_URL}/scripts/codex-core.mjs?aw=${Date.now()}`);
  const job = core.startJob({
    mode: "review",
    backend: "app-server",
    appServerCommand: command,
    reviewTarget: { type: "uncommittedChanges" },
    prompt: "exec fallback prompt",
    cwd: d,
  });

  const deadline = Date.now() + 5_000;
  while (core.resolveJob(job.id, d)?.status === "running" && Date.now() < deadline) await sleep(50);
  const restarted = await import(`${ROOT_URL}/scripts/codex-core.mjs?aw2=${Date.now()}`);
  const saved = restarted.resolveJob(job.id, d);
  assert.equal(saved.status, "done");
  assert.equal(saved.backend, "app-server");
  assert.equal(restarted.jobAnswer(job.id), "native review result");
  assert.equal(restarted.jobProgress(job.id).finished, true);
});

await t("31h. codex_cancel доходит через detached worker до turn/interrupt", async () => {
  const d = fresh("app-worker-cancel");
  const log = path.join(d, "rpc.jsonl");
  process.env.CLAUDE_PLUGIN_DATA = path.join(d, "data");
  process.env.FAKE_APP_LOG = log;
  const core = await import(`${ROOT_URL}/scripts/codex-core.mjs?ac=${Date.now()}`);
  const job = core.startJob({
    mode: "review",
    backend: "app-server",
    appServerCommand: fakeAppServer(d, "cancel"),
    reviewTarget: { type: "uncommittedChanges" },
    prompt: "exec fallback prompt",
    cwd: d,
  });

  const acceptedDeadline = Date.now() + 5_000;
  while (
    (!fs.existsSync(log) || !fs.readFileSync(log, "utf8").includes('"method":"review/start"')) &&
    Date.now() < acceptedDeadline
  ) await sleep(50);
  assert.equal(core.cancelJob(job.id).ok, true);

  const interruptDeadline = Date.now() + 5_000;
  while (
    (!fs.existsSync(log) || !fs.readFileSync(log, "utf8").includes('"method":"turn/interrupt"')) &&
    Date.now() < interruptDeadline
  ) await sleep(50);
  delete process.env.FAKE_APP_LOG;

  const messages = fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
  const interrupt = messages.find((message) => message.method === "turn/interrupt");
  assert.deepEqual(interrupt?.params, { threadId: "thread-1", turnId: "turn-1" });
  assert.equal(core.resolveJob(job.id, d).status, "cancelled");
});

await t("31i. серверный JSON-RPC-запрос не принимается за ответ с совпавшим id", async () => {
  const d = fresh("app-id-collision");
  const log = path.join(d, "rpc.jsonl");
  process.env.FAKE_APP_LOG = log;
  const app = await import(`${ROOT_URL}/scripts/app-server.mjs?id=${Date.now()}`);
  const r = await app.runAppServerReview({
    cwd: d,
    command: fakeAppServer(d, "collision"),
    target: { type: "uncommittedChanges" },
  });
  delete process.env.FAKE_APP_LOG;

  assert.equal(r.output, "native review result");
  const messages = fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
  const refusal = messages.find((message) => message.id === 1 && message.error);
  assert.equal(refusal?.error?.code, -32601);
});

await t("31j. медленный ответ review/start не вызывает неоднозначный fallback по таймауту", async () => {
  const d = fresh("app-delayed-review");
  const app = await import(`${ROOT_URL}/scripts/app-server.mjs?slow=${Date.now()}`);
  let fallbacks = 0;
  const r = await app.runAppServerReviewWithFallback(
    {
      cwd: d,
      command: fakeAppServer(d, "delayed"),
      target: { type: "uncommittedChanges" },
      requestTimeoutMs: 1_000,
    },
    async () => ({ fallback: ++fallbacks })
  );
  assert.equal(r.output, "native review result");
  assert.equal(fallbacks, 0);
});

await t("31k. отмена ожидающего review/start не запускает exec fallback", async () => {
  const d = fresh("app-cancel-pending");
  const app = await import(`${ROOT_URL}/scripts/app-server.mjs?pending=${Date.now()}`);
  const controller = new AbortController();
  let fallbacks = 0;
  setTimeout(() => controller.abort(), 50);
  const r = await app.runAppServerReviewWithFallback(
    {
      cwd: d,
      command: fakeAppServer(d, "hang"),
      target: { type: "uncommittedChanges" },
      signal: controller.signal,
    },
    async () => ({ fallback: ++fallbacks })
  );
  assert.equal(r.cancelled, true);
  assert.equal(fallbacks, 0);
});

// ───────────────────────────────── 34. Исправления повторного code review

function runClaudeTaskCase(dir, config) {
  return new Promise((resolve, reject) => {
    const exposed = path.join(dir, "exposed.json");
    const argvFile = path.join(dir, "claude-argv.json");
    fs.writeFileSync(exposed, JSON.stringify(config));
    const claude = path.join(dir, "claude");
    fs.writeFileSync(
      claude,
      `#!/usr/bin/env node
require("fs").writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));
console.log("ok");`,
      { mode: 0o755 }
    );

    const child = spawn(process.execPath, [path.join(ROOT, "bridge", "mcp-claude.mjs")], {
      env: { ...process.env, CLAUDE_BIN: claude, TANDEM_EXPOSED: exposed },
    });
    const messages = [];
    const stderr = [];
    readline.createInterface({ input: child.stdout }).on("line", (line) => {
      if (!line.trim()) return;
      try { messages.push(JSON.parse(line)); } catch {}
    });
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`обратный мост не завершился после EOF: ${Buffer.concat(stderr).toString("utf8")}`));
    }, 5_000);
    child.on("close", () => {
      clearTimeout(timer);
      resolve({ messages, argvFile });
    });
    child.stdin.end(
      [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "claude_task", arguments: { task: "x", write: true } } },
      ].map(JSON.stringify).join("\n") + "\n"
    );
  });
}

await tExec("34a. write-задача без административного task_tools отклоняется", async () => {
  const d = fresh("write-tools-missing");
  const { messages, argvFile } = await runClaudeTaskCase(d, { servers: {}, allow_task: true });
  assert.equal(messages.find((m) => m.id === 2)?.result?.isError, true);
  assert.ok(!fs.existsSync(argvFile), "Claude запущен без административного allowlist");
});

await tExec("34b. пустой административный task_tools означает deny-all", async () => {
  const d = fresh("write-tools-empty");
  const { messages, argvFile } = await runClaudeTaskCase(d, { servers: {}, allow_task: true, task_tools: [] });
  assert.equal(messages.find((m) => m.id === 2)?.result?.isError, true);
  assert.ok(!fs.existsSync(argvFile), "пустой allowlist раскрыл все инструменты Claude");
});

await tExec("34c. непустой task_tools ограничивает write-задачу через --tools", async () => {
  const d = fresh("write-tools-nonempty");
  const { messages, argvFile } = await runClaudeTaskCase(d, { servers: {}, allow_task: true, task_tools: ["Read"] });
  assert.equal(messages.find((m) => m.id === 2)?.result?.isError, undefined);
  const argv = JSON.parse(fs.readFileSync(argvFile, "utf8"));
  assert.equal(argv[argv.indexOf("--tools") + 1], "Read");
});

await t("34d. resolveInside отвергает выход через symlink или junction", async () => {
  const root = fresh("image-realpath-root");
  const outside = fresh("image-realpath-outside");
  const link = path.join(root, "escape");
  fs.symlinkSync(outside, link, WIN ? "junction" : "dir");
  const img = await import(`${ROOT_URL}/scripts/image-core.mjs?realpath=${Date.now()}`);
  assert.throws(
    () => img.resolveInside(root, path.join("escape", "new.png"), "out_dir"),
    /outside|предел|project|проекта/i
  );
});

await t("34e. setup сообщает конфликт link-back и выходит с ненулевым кодом", async () => {
  const d = fresh("setup-link-conflict");
  const config = path.join(d, "config.toml");
  const original = '[mcp_servers.claude-bridge]\ncommand = "custom"\n';
  fs.writeFileSync(config, original, { mode: 0o600 });
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "setup.mjs"), "--link-back"], {
    cwd: d,
    encoding: "utf8",
    env: {
      ...process.env,
      TANDEM_LANG: "en",
      TANDEM_CONFIG: config,
      TANDEM_EXPOSED: path.join(d, "exposed.json"),
      CLAUDE_PLUGIN_DATA: path.join(d, "data"),
      CODEX_BIN: process.execPath,
      CLAUDE_BIN: process.execPath,
    },
  });
  assert.notEqual(r.status, 0, "конфликт был выдан за успешное обновление");
  assert.match(`${r.stdout}\n${r.stderr}`, /already contains|conflict/i);
  assert.ok(!`${r.stdout}\n${r.stderr}`.includes("undefined"));
  assert.equal(fs.readFileSync(config, "utf8"), original);
});

await t("34f. quoted TOML-таблица claude-bridge тоже считается конфликтом", async () => {
  const d = fresh("toml-quoted-conflict");
  const config = path.join(d, "config.toml");
  const original = '[mcp_servers."claude-bridge"]\ncommand = "custom"\n';
  fs.writeFileSync(config, original);
  process.env.TANDEM_CONFIG = config;
  const root = path.join(d, "plugin");
  fs.mkdirSync(path.join(root, "bridge"), { recursive: true });
  fs.writeFileSync(path.join(root, "bridge", "mcp-claude.mjs"), "");
  const lb = await import(`${ROOT_URL}/scripts/link-back.mjs?quoted=${Date.now()}`);
  assert.equal(lb.link(root).action, "conflict");
  assert.equal(fs.readFileSync(config, "utf8"), original);
});

await tExec("34g. атомарная перезапись config.toml сохраняет режим 0600", async () => {
  const d = fresh("toml-mode");
  const config = path.join(d, "config.toml");
  fs.writeFileSync(config, 'model = "x"\n', { mode: 0o600 });
  fs.chmodSync(config, 0o600);
  process.env.TANDEM_CONFIG = config;
  const root = path.join(d, "plugin");
  fs.mkdirSync(path.join(root, "bridge"), { recursive: true });
  fs.writeFileSync(path.join(root, "bridge", "mcp-claude.mjs"), "");
  const lb = await import(`${ROOT_URL}/scripts/link-back.mjs?mode=${Date.now()}`);
  assert.equal(lb.link(root).action, "added");
  assert.equal(fs.statSync(config).mode & 0o777, 0o600);
});

await t("34h. EOF останавливает MCP-proxy после завершения текущих вызовов", async () => {
  const d = fresh("reverse-proxy-eof");
  const nested = path.join(d, "nested.mjs");
  fs.writeFileSync(
    nested,
    `import readline from "node:readline";
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "nested", version: "1" } } }) + "\\n");
  if (m.method === "tools/list") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { tools: [] } }) + "\\n");
});`
  );
  const exposed = path.join(d, "exposed.json");
  fs.writeFileSync(exposed, JSON.stringify({
    servers: { nested: { command: process.execPath, args: [nested], tools: ["*"] } },
    allow_task: false,
  }));

  const started = Date.now();
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, "bridge", "mcp-claude.mjs")], {
      env: { ...process.env, TANDEM_EXPOSED: exposed },
    });
    const stderr = [];
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`мост завис после EOF: ${Buffer.concat(stderr).toString("utf8")}`));
    }, 5_000);
    child.on("close", () => { clearTimeout(timer); resolve(); });
    child.stdin.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
  });
  assert.ok(Date.now() - started < 4_000, "proxy удерживал event loop после EOF");
});

await tExec("34i. генерация изображения асинхронна и отменяет дерево Codex", async () => {
  const d = fresh("image-cancel-async");
  process.env.CODEX_BIN = fakeCodex(d);
  process.env.CLAUDE_PLUGIN_DATA = path.join(d, "data");
  process.env.FAKE = "slow";
  const img = await import(`${ROOT_URL}/scripts/image-core.mjs?cancel=${Date.now()}`);
  const controller = new AbortController();
  let eventLoopTicked = false;
  setTimeout(() => { eventLoopTicked = true; controller.abort(); }, 100);
  const started = Date.now();
  const pending = img.generateImage({ prompt: "x", cwd: d, signal: controller.signal, timeoutMs: 5_000 });
  assert.equal(typeof pending?.then, "function", "MCP-путь остался синхронным");
  const result = await pending;
  assert.equal(result.aborted, true);
  assert.equal(eventLoopTicked, true, "event loop был заблокирован генерацией");
  assert.ok(Date.now() - started < 3_000, "отмена не остановила процесс вовремя");
  delete process.env.FAKE;
});

await t("34j. параллельные процессы не теряют записи prefs.json", async () => {
  const d = fresh("prefs-concurrent");
  const writer = path.join(d, "writer.mjs");
  const ready = path.join(d, "ready.txt");
  const go = path.join(d, "go");
  fs.writeFileSync(
    writer,
    `import fs from "node:fs";
import { writePrefs } from ${JSON.stringify(`${ROOT_URL}/scripts/prefs.mjs`)};
fs.appendFileSync(process.env.READY, "1\\n");
const cell = new Int32Array(new SharedArrayBuffer(4));
while (!fs.existsSync(process.env.GO)) Atomics.wait(cell, 0, 0, 5);
writePrefs(process.argv[2], { model: process.argv[3] });`
  );
  const count = 8;
  const children = Array.from({ length: count }, (_, i) =>
    spawn(process.execPath, [writer, `/repo/${i}`, `model-${i}`], {
      env: {
        ...process.env,
        CLAUDE_PLUGIN_DATA: path.join(d, "jobs"),
        READY: ready,
        GO: go,
      },
    })
  );
  const deadline = Date.now() + 5_000;
  while ((!fs.existsSync(ready) || fs.readFileSync(ready, "utf8").trim().split("\n").length < count) && Date.now() < deadline) {
    await sleep(20);
  }
  fs.writeFileSync(go, "go");
  await Promise.all(children.map((child) => new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`writer exited ${code}`)));
  })));
  const all = JSON.parse(fs.readFileSync(path.join(d, "jobs", "prefs.json"), "utf8"));
  assert.equal(Object.keys(all).length, count);
  for (let i = 0; i < count; i++) assert.equal(all[`/repo/${i}`]?.model, `model-${i}`);
});

await t("32a. скалярное JSON-сообщение не роняет MCP-сервер", async () => {
  const d = fresh("mcp-scalar");
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "mcp-codex.mjs")], {
    input: 'null\n"строка"\n{"jsonrpc":"2.0","id":7,"method":"ping"}\n',
    encoding: "utf8",
    timeout: 20_000,
    env: { ...process.env, TANDEM_LANG: "en", CLAUDE_PLUGIN_DATA: path.join(d, "data") },
  });
  const out = `${r.stdout}`;
  assert.ok(!/TypeError|Cannot destructure/.test(`${r.stdout}${r.stderr}`), "сервер упал на скаляре");
  assert.match(out, /"code":-32600/, "нет отказа -32600 на скалярное сообщение");
  assert.match(out, /"id":7[,}]/, "сервер не дожил до следующего запроса");
});

await t("32b. слишком длинная строка отвергается до разбора", async () => {
  const d = fresh("mcp-huge");
  const huge = `{"jsonrpc":"2.0","id":1,"method":"ping","params":{"x":"${"a".repeat(17 * 1024 * 1024)}"}}`;
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "mcp-codex.mjs")], {
    input: `${huge}\n{"jsonrpc":"2.0","id":2,"method":"ping"}\n`,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, TANDEM_LANG: "en", CLAUDE_PLUGIN_DATA: path.join(d, "data") },
  });
  assert.match(`${r.stdout}`, /"code":-32600/, "предел размера сообщения не сработал");
  assert.match(`${r.stdout}`, /"id":2[,}]/, "сервер не пережил слишком длинное сообщение");
});

await t("32c. код возврата появляется только после дописанного журнала", async () => {
  const d = fresh("worker-flush");
  const talker = path.join(d, "talker.mjs");
  // Много строк подряд и мгновенный выход: событие exit придёт раньше, чем
  // читатель успеет разобрать stdout, если воркер ждёт не того события.
  const lines = 4000;
  fs.writeFileSync(
    talker,
    // Без process.exit: на POSIX stdout процесса — pipe, и принудительный
// выход выбросил бы недописанное ядром, то есть тест ловил бы собственную
// потерю данных вместо гонки в воркере. Процесс уходит сам, дописав всё.
    `let s = "";
for (let i = 0; i < ${lines}; i++) s += JSON.stringify({ type: "item.completed", item: { type: "agentMessage", text: "строка " + i } }) + "\\n";
process.stdout.write(s);
`
  );
  const spec = {
    bin: process.execPath,
    args: [talker],
    promptFile: path.join(d, "prompt"),
    outFile: path.join(d, "out"),
    codeFile: path.join(d, "code"),
    noteFile: path.join(d, "note"),
    cancelFile: path.join(d, "cancel"),
    aliveFile: path.join(d, "alive"),
    heartbeatMs: 1000,
    cwd: d,
    backend: "exec",
    timeoutMs: 60_000,
  };
  fs.writeFileSync(spec.promptFile, "hi");
  const specFile = path.join(d, "spec.json");
  fs.writeFileSync(specFile, JSON.stringify(spec));

  const child = spawn(process.execPath, [path.join(ROOT, "scripts", "job-worker.mjs"), specFile], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  // Читатель ведёт себя как followJob: увидев код возврата, дочитывает журнал.
  let seen = 0;
  for (let i = 0; i < 600; i++) {
    if (fs.existsSync(spec.codeFile)) {
      seen = fs.readFileSync(spec.outFile, "utf8").split("\n").filter((l) => l.trim()).length;
      break;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  child.kill();
  assert.equal(seen, lines, `журнал оборван: ${seen} строк вместо ${lines}`);
});

await t("32d. отменённая задача остаётся в учёте, пока жив её воркер", async () => {
  const d = fresh("cancel-limit");
  process.env.CLAUDE_PLUGIN_DATA = path.join(d, "data");
  const core = await import(`${ROOT_URL}/scripts/codex-core.mjs?cl=${Date.now()}`);
  const dir = core.dataDir();
  const id = "job-cccc1111";
  const victim = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  fs.writeFileSync(
    path.join(dir, `${id}.json`),
    JSON.stringify({
      id,
      pid: victim.pid,
      mode: "delegate",
      status: "running",
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      repo: d,
      cwd: d,
    })
  );
  fs.writeFileSync(path.join(dir, `${id}.alive`), new Date().toISOString());
  assert.equal(core.liveJobs().length, 1, "живая задача не учтена");
  core.cancelJob(id);
  fs.writeFileSync(path.join(dir, `${id}.alive`), new Date().toISOString());
  assert.equal(core.liveJobs().length, 1, "отмена сняла задачу с учёта, пока процесс ещё жив");
  victim.kill();
});

await t("32e. задача с чужим pid и протухшей меткой не считается живой", async () => {
  const d = fresh("stale-heartbeat");
  process.env.CLAUDE_PLUGIN_DATA = path.join(d, "data");
  const core = await import(`${ROOT_URL}/scripts/codex-core.mjs?sh=${Date.now()}`);
  const dir = core.dataDir();
  const id = "job-dddd2222";
  const victim = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  fs.writeFileSync(
    path.join(dir, `${id}.json`),
    JSON.stringify({
      id,
      pid: victim.pid, // номер занят посторонним процессом
      mode: "delegate",
      status: "running",
      startedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      repo: d,
      cwd: d,
    })
  );
  const old = new Date(Date.now() - 5 * 60_000);
  fs.writeFileSync(path.join(dir, `${id}.alive`), "old");
  fs.utimesSync(path.join(dir, `${id}.alive`), old, old);

  assert.equal(core.liveJobs().length, 0, "чужой процесс принят за живой воркер");
  assert.equal(core.resolveJob(id, d).status, "unknown");
  assert.ok(!victim.killed, "посторонний процесс был убит страховкой");
  victim.kill();
});

await t("32f. таймаут задачи из настройки проверяется", async () => {
  const core = await import(`${ROOT_URL}/scripts/codex-core.mjs?jt=${Date.now()}`);
  const prev = process.env.TANDEM_JOB_TIMEOUT_MIN;
  for (const [value, expected] of [
    ["-5", 30],
    ["мусор", 30],
    ["0", 30],
    ["10000", 480],
    ["45", 45],
  ]) {
    process.env.TANDEM_JOB_TIMEOUT_MIN = value;
    assert.equal(core.jobTimeoutMs(), expected * 60_000, `значение ${value} принято как есть`);
  }
  if (prev === undefined) delete process.env.TANDEM_JOB_TIMEOUT_MIN;
  else process.env.TANDEM_JOB_TIMEOUT_MIN = prev;
});

await t("32g. содержимое отслеживаемого файла с секретами не уходит в диф", async () => {
  const d = fresh("diff-secrets");
  const git = (...a) => spawnSync("git", a, { cwd: d, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  fs.writeFileSync(path.join(d, ".env"), "OPENAI_API_KEY=sk-should-never-be-shown\n");
  fs.writeFileSync(path.join(d, "app.js"), "const a = 1;\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  fs.writeFileSync(path.join(d, ".env"), "OPENAI_API_KEY=sk-still-secret-after-change\n");
  fs.writeFileSync(path.join(d, "app.js"), "const a = 2;\n");

  const core = await import(`${ROOT_URL}/scripts/codex-core.mjs?ds=${Date.now()}`);
  const diff = core.collectDiff(d, null);
  assert.ok(!/sk-still-secret-after-change/.test(diff), "содержимое .env попало в диф");
  assert.match(diff, /\.env/, "сам факт изменения .env скрыт от ревью");
  assert.match(diff, /const a = 2;/, "обычные изменения потерялись вместе с секретом");
});

await t("32h. отсутствие общего предка — явный отказ, а не другое сравнение", async () => {
  const d = fresh("no-merge-base");
  const git = (...a) => spawnSync("git", a, { cwd: d, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  fs.writeFileSync(path.join(d, "a.txt"), "a\n");
  git("add", "-A");
  git("commit", "-qm", "first");
  git("checkout", "-q", "--orphan", "other");
  fs.writeFileSync(path.join(d, "b.txt"), "b\n");
  git("add", "-A");
  git("commit", "-qm", "unrelated");

  const core = await import(`${ROOT_URL}/scripts/codex-core.mjs?nmb=${Date.now()}`);
  const first = git("rev-parse", "master").stdout.trim() || git("rev-parse", "main").stdout.trim();
  assert.throws(() => core.collectDiff(d, first), /общего предка|common ancestor/i);
});

await t("32i. потоковые дельты и счётчики токенов не попадают в журнал", async () => {
  const ev = await import(`${ROOT_URL}/scripts/codex-events.mjs?dl=${Date.now()}`);
  assert.equal(
    ev.fromAppServerNotification({ method: "item/agentMessage/delta", params: { delta: "чат" } }),
    null,
    "дельта ответа пишется в журнал"
  );
  assert.equal(
    ev.fromAppServerNotification({ method: "thread/tokenUsage/updated", params: {} }),
    null,
    "обновление счётчиков пишется в журнал"
  );
  assert.equal(
    ev.fromAppServerNotification({ method: "item/completed", params: { item: { type: "agentMessage", text: "да" } } })
      ?.type,
    "item.completed",
    "полезное событие потерялось вместе с шумом"
  );
});

await t("32j. многобайтные символы переживают границу чтения журнала", async () => {
  const d = fresh("decoder");
  process.env.CLAUDE_PLUGIN_DATA = path.join(d, "data");
  const core = await import(`${ROOT_URL}/scripts/codex-core.mjs?dec=${Date.now()}`);
  const dir = core.dataDir();
  const id = "job-eeee3333";
  const line = JSON.stringify({ type: "item.completed", item: { type: "agentMessage", text: "проверка кириллицы" } });
  const buf = Buffer.from(`${line}\n`, "utf8");
  const file = path.join(dir, `${id}.out`);
  fs.writeFileSync(file, buf.subarray(0, buf.length - 12)); // обрыв внутри символа

  const events = [];
  const follow = core.followJob(id, { timeoutMs: 3_000, pollMs: 20, onEvent: (e) => events.push(e) });
  await new Promise((r) => setTimeout(r, 200));
  fs.appendFileSync(file, buf.subarray(buf.length - 12));
  fs.writeFileSync(path.join(dir, `${id}.code`), "0");
  await follow;

  assert.equal(events.length, 1, "событие не собралось из двух чтений");
  assert.equal(events[0].item.text, "проверка кириллицы", "кириллица испорчена на границе чтения");
});

await t("32k. без промпта нативное ревью не подменяется exec", async () => {
  const d = fresh("no-fallback");
  const app = await import(`${ROOT_URL}/scripts/app-server.mjs?nf=${Date.now()}`);
  let fallbacks = 0;
  await assert.rejects(
    app.runAppServerReviewWithFallback(
      { cwd: d, command: fakeAppServer(d, "exit"), target: { type: "uncommittedChanges" }, requestTimeoutMs: 5_000 },
      async (error) => {
        fallbacks++;
        throw error;
      }
    )
  );
  assert.equal(fallbacks, 0, "после отправки review/start запущен второй расход квоты");
});

// ───────────────────────────────── отчёт

const failed = results.filter((r) => !r.ok);
const skipped = results.filter((r) => r.skipped);
for (const r of results) {
  const mark = r.skipped ? "  skip" : r.ok ? "  ok  " : "  FAIL";
  console.log(`${mark}  ${r.name}${r.ok ? "" : `\n         ${r.error}`}`);
}
const ran = results.length - skipped.length;
console.log(
  `\n${ran - failed.length}/${ran} пройдено` + (skipped.length ? `, ${skipped.length} пропущено (нужен POSIX)` : "")
);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
