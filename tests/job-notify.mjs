#!/usr/bin/env node
// Проверки уведомлений фоновых задач без запуска Codex.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const ROOT_URL = pathToFileURL(ROOT).href;
const SCRIPT = path.join(ROOT, "scripts", "job-notify.mjs");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "tandem-notify-"));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let passed = 0;
let failed = 0;
let skipped = 0;

function assertJob(envPath, jobId, { status = "failed", startedAt = new Date().toISOString(), timeoutMs = 30_000, pid = process.pid } = {}) {
  const jobs = path.join(envPath, "jobs");
  fs.mkdirSync(jobs, { recursive: true });
  fs.writeFileSync(path.join(jobs, `${jobId}.json`), JSON.stringify({ id: jobId, mode: "delegate", status, pid, startedAt }));
  fs.writeFileSync(path.join(jobs, `${jobId}.spec`), JSON.stringify({ timeoutMs }));
  return jobs;
}

let nextId = 0;
function id() {
  return `job-${String(++nextId).padStart(8, "0")}`;
}

async function test(name, fn) {
  try {
    const result = await fn();
    if (result === "skip") {
      skipped++;
      process.stdout.write(`skip  ${name}\n`);
      return;
    }
    passed++;
    process.stdout.write(`ok  ${name}\n`);
  } catch (error) {
    failed++;
    process.stderr.write(`not ok  ${name}: ${error.stack || error}\n`);
  }
}

async function loadNotify(envPath) {
  process.env.CLAUDE_PLUGIN_DATA = envPath;
  return import(`${ROOT_URL}/scripts/job-notify.mjs?test=${Date.now()}-${Math.random()}`);
}

function input(jobId, tool = "mcp__tandem__codex_delegate", toolResponse) {
  return {
    hook_event_name: "PostToolUse",
    tool_name: tool,
    session_id: "session-test",
    tool_response: toolResponse ?? { content: [{ type: "text", text: JSON.stringify({ message: "queued", tandem_job: { id: jobId, language: "en" } }) }] },
  };
}

function runHook(envPath, hookInput) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT], { env: { ...process.env, CLAUDE_PLUGIN_DATA: envPath }, stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("hook subprocess timed out")); }, 15_000);
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal, stderr }); });
    child.stdin.end(JSON.stringify(hookInput));
  });
}

await test("backgroundReply связывает ответ явной tandem_job меткой", async () => {
  const envPath = path.join(TMP, "reply");
  const notify = await loadNotify(envPath);
  const reply = notify.backgroundReply("job-1234abcd", { message: "queued", count: 2 });
  assert.equal(reply.content[0].type, "text");
  const body = JSON.parse(reply.content[0].text);
  assert.equal(body.message, "queued");
  assert.deepEqual(body.tandem_job, { id: "job-1234abcd", language: "en" });
});

await test("принимаются MCP object, content array и сериализованный JSON shapes", async () => {
  const envPath = path.join(TMP, "shapes");
  const notify = await loadNotify(envPath);
  for (const shape of ["object", "array", "string"]) {
    const jobId = id();
    assertJob(envPath, jobId);
    const payload = { message: "queued", tandem_job: { id: jobId, language: "ru" } };
    const response = shape === "object"
      ? { content: [{ type: "text", text: JSON.stringify(payload) }] }
      : shape === "array"
        ? [{ type: "text", text: JSON.stringify(payload) }]
        : JSON.stringify(payload);
    const notice = await notify.watchJobNotification(input(jobId, undefined, response), { pollMs: 5, graceMs: 0 });
    assert.match(notice, new RegExp(jobId));
  }
});

await test("принимаются только разрешённые producer tools", async () => {
  const envPath = path.join(TMP, "producers");
  const notify = await loadNotify(envPath);
  for (const producer of ["ask", "chat", "delegate", "review", "challenge", "collaborate"]) {
    const jobId = id();
    assertJob(envPath, jobId);
    const notice = await notify.watchJobNotification(input(jobId, `mcp__server__codex_${producer}`), { pollMs: 5, graceMs: 0 });
    assert.match(notice, new RegExp(jobId), `${producer} не дал уведомление`);
  }
  for (const tool of ["mcp__server__codex_status", "mcp__server__codex_result", "mcp__server__other"]) {
    const jobId = id();
    assertJob(envPath, jobId);
    assert.equal(await notify.watchJobNotification(input(jobId, tool), { pollMs: 5, graceMs: 0 }), null, `${tool} неожиданно подписал hook`);
  }
  const collabId = id();
  assertJob(envPath, collabId);
  const poll = input(collabId, "mcp__server__codex_collaborate");
  poll.tool_input = { action: "status" };
  assert.equal(await notify.watchJobNotification(poll, { pollMs: 5, graceMs: 0 }), null, "collaborate status создал watcher");
});

await test("игнорируются произвольные job ids без явной tandem_job метки и недоверенные ids", async () => {
  const envPath = path.join(TMP, "hostile");
  const notify = await loadNotify(envPath);
  const jobId = id();
  assertJob(envPath, jobId);
  const responses = [
    `task ${jobId} failed`,
    { content: [{ type: "text", text: `{"id":"${jobId}","message":"failed"}` }] },
    { content: [{ type: "text", text: "{" }] },
    { content: [{ type: "text", text: JSON.stringify({ tandem_job: { id: "../../outside", language: "en" } }) }] },
    { content: [{ type: "text", text: JSON.stringify({ tandem_job: { id: "", language: "en" } }) }] },
    { content: [{ type: "text", text: JSON.stringify({ tandem_job: { id: 7, language: "en" } }) }] },
    { isError: true, content: [{ type: "text", text: JSON.stringify({ tandem_job: { id: jobId, language: "en" } }) }] },
  ];
  for (const response of responses) {
    assert.equal(await notify.watchJobNotification(input(jobId, undefined, response), { pollMs: 5, graceMs: 0 }), null);
  }
});

await test("failed и unknown дают уведомление; done и cancelled молчат", async () => {
  const envPath = path.join(TMP, "terminal");
  const notify = await loadNotify(envPath);
  for (const status of ["failed", "unknown", "timeout"]) {
    const jobId = id();
    assertJob(envPath, jobId, { status });
    const notice = await notify.watchJobNotification(input(jobId), { pollMs: 5, graceMs: 0 });
    assert.match(notice, new RegExp(jobId));
    assert.match(notice, new RegExp(`\\[${status}\\]`));
  }
  for (const status of ["done", "cancelled"]) {
    const jobId = id();
    assertJob(envPath, jobId, { status });
    assert.equal(await notify.watchJobNotification(input(jobId), { pollMs: 5, graceMs: 0 }), null);
  }
});

await test("note до code ждёт код выхода, а не объявляет задачу завершённой", async () => {
  const envPath = path.join(TMP, "note-before-code");
  const notify = await loadNotify(envPath);
  const jobId = id();
  const jobs = assertJob(envPath, jobId, { status: "running", timeoutMs: 5000 });
  fs.writeFileSync(path.join(jobs, `${jobId}.note`), "timeout");
  let settled = false;
  const pending = notify.watchJobNotification(input(jobId), { pollMs: 10, graceMs: 0 }).then((value) => { settled = true; return value; });
  await sleep(60);
  assert.equal(settled, false, "уведомление отправлено до .code");
  fs.writeFileSync(path.join(jobs, `${jobId}.code`), "124");
  const notice = await pending;
  assert.match(notice, new RegExp(jobId));
  assert.match(notice, /timeout/);
});

await test("deadline с индивидуальным timeout сообщает о неподтверждённом завершении и не убивает процесс", async () => {
  const envPath = path.join(TMP, "deadline");
  const notify = await loadNotify(envPath);
  const jobId = id();
  assertJob(envPath, jobId, { status: "running", startedAt: new Date(Date.now() - 80).toISOString(), timeoutMs: 35, pid: process.pid });
  const notice = await notify.watchJobNotification(input(jobId), { pollMs: 5, graceMs: 10 });
  assert.match(notice, new RegExp(`\\[unresponsive\\]`));
  assert.match(notice, /unconfirmed|не подтвержд|неподтвержд/i);
  assert.doesNotThrow(() => process.kill(process.pid, 0), "проверяемый процесс был остановлен");
});

await test("параллельные watcher instances создают одно уведомление", async () => {
  const envPath = path.join(TMP, "concurrent");
  const notify = await loadNotify(envPath);
  const jobId = id();
  assertJob(envPath, jobId);
  const results = await Promise.all(Array.from({ length: 12 }, () => notify.watchJobNotification(input(jobId), { pollMs: 5, graceMs: 0 })));
  assert.equal(results.filter(Boolean).length, 1, `уведомлений: ${results.filter(Boolean).length}`);
});

await test("параллельные hook subprocesses атомарно дедуплицируют уведомление", async () => {
  const envPath = path.join(TMP, "process-race");
  const jobId = id();
  assertJob(envPath, jobId);
  const hookInput = input(jobId);
  const results = await Promise.all(Array.from({ length: 8 }, () => runHook(envPath, hookInput)));
  assert.equal(results.filter((result) => result.code === 2).length, 1, "ожидался ровно один exit 2");
  assert.equal(results.filter((result) => result.stderr.includes(jobId)).length, 1, "stderr получен не ровно одним процессом");
  assert.ok(results.every((result) => result.code === 0 || result.code === 2), JSON.stringify(results));
});

await test("MCP codex_delegate wait_seconds:0 возвращает явный job marker", async () => {
  const envPath = path.join(TMP, "mcp-integration");
  fs.mkdirSync(envPath, { recursive: true });
  const fakeCodex = path.join(TMP, "fake-codex.cjs");
  fs.writeFileSync(fakeCodex, `const path=require("node:path");\nconst entry=path.basename(process.argv[1]||"");\nconst a=process.argv.slice(2);\nif(entry==="login"||entry==="status"){console.log("Logged in");process.exit(0)}\nif(entry==="exec"&&a[0]==="--help"){console.log("Usage: codex exec\\n  --sandbox <mode>\\n  --cd <dir>");process.exit(0)}\nif(entry==="exec"){setTimeout(()=>process.exit(7),30)}\n`);
  const messages = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, "scripts", "mcp-codex.mjs")], {
      cwd: ROOT,
      env: { ...process.env, CLAUDE_PLUGIN_DATA: envPath, CODEX_BIN: process.execPath, NODE_OPTIONS: `--require=${JSON.stringify(fakeCodex)}`, TANDEM_CWD: ROOT },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const output = [];
    let errorText = "";
    let partial = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error(`MCP integration timed out: ${errorText}`)); }, 20_000);
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      partial += chunk;
      for (const line of partial.split("\n").slice(0, -1)) {
        try { output.push(JSON.parse(line)); } catch {}
      }
      partial = partial.split("\n").at(-1) || "";
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { errorText += chunk; });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => { clearTimeout(timer); code === 0 ? resolve(output) : reject(new Error(`MCP server exit ${code}: ${errorText}`)); });
    child.stdin.end([
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "codex_delegate", arguments: { task: "test", wait_seconds: 0 } } }),
    ].join("\n") + "\n");
  });
  const call = messages.find((message) => message.id === 2);
  assert.ok(call?.result, `MCP-ответ не получен: ${JSON.stringify(call)}`);
  assert.notEqual(call.result.isError, true, `MCP-инструмент вернул ошибку: ${JSON.stringify(call.result)}`);
  const payload = JSON.parse(call.result.content[0].text);
  assert.match(payload.tandem_job.id, /^job-[0-9a-f]{8}$/);
  assert.ok(["ru", "en"].includes(payload.tandem_job.language));
});

await test("completedStatus повторно читает code после гонки ENOENT", async () => {
  const envPath = path.join(TMP, "code-race");
  const jobs = path.join(envPath, "jobs");
  const jobId = id();
  fs.mkdirSync(jobs, { recursive: true });
  fs.writeFileSync(path.join(jobs, `${jobId}.json`), JSON.stringify({ id: jobId, mode: "delegate", status: "running", pid: 987654321, startedAt: new Date(Date.now() - 60_000).toISOString() }));
  fs.writeFileSync(path.join(jobs, `${jobId}.spec`), JSON.stringify({ timeoutMs: 1000 }));
  const script = `import fs from "node:fs";\nconst original=fs.readFileSync; let intercepted=false;\nfs.readFileSync=function(file,...args){if(!intercepted&&String(file).endsWith(${JSON.stringify(`${jobId}.code`)})){intercepted=true; fs.writeFileSync(${JSON.stringify(path.join(jobs, `${jobId}.code`))},"0"); throw Object.assign(new Error("raced"),{code:"ENOENT"})} return original.call(fs,file,...args)};\nconst core=await import(${JSON.stringify(`${ROOT_URL}/scripts/codex-core.mjs?race=${Date.now()}`)});\nconst state=core.jobNotificationState(${JSON.stringify(jobId)});\nif(state.status!=="done") throw new Error("status="+state.status);\nconst hook=await import(${JSON.stringify(`${ROOT_URL}/scripts/job-notify.mjs?race=${Date.now()}`)});\nconst input={hook_event_name:"PostToolUse",tool_name:"mcp__tandem__codex_delegate",tool_response:{content:[{type:"text",text:JSON.stringify({tandem_job:{id:${JSON.stringify(jobId)},language:"en"}})}]}};\nconst notice=await hook.watchJobNotification(input,{pollMs:1,graceMs:0});\nif(notice!==null) throw new Error("unexpected notification="+notice);`;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, CLAUDE_PLUGIN_DATA: envPath }, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("race subprocess timed out")); }, 5_000);
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => { clearTimeout(timer); resolve({ code, stderr }); });
  });
  assert.equal(result.code, 0, result.stderr);
});

await test("direct entry читает stdin, пишет stderr и выходит с кодом 2 при уведомлении", async () => {
  const envPath = path.join(TMP, "direct");
  const jobId = id();
  assertJob(envPath, jobId);
  const result = await runHook(envPath, input(jobId));
  assert.equal(result.code, 2);
  assert.match(result.stderr, new RegExp(jobId));
});

await test("hooks matcher покрывает server names, а asyncRewake превышает 480 минут", async () => {
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, "hooks", "hooks.json"), "utf8"));
  const entries = config.hooks?.PostToolUse || [];
  const entry = entries.find(({ matcher, hooks = [] }) => matcher?.includes("codex_(ask|chat|delegate|review|challenge|collaborate)") && hooks.some((hook) => /job-notify\.mjs/.test(hook.command || "")));
  assert.ok(entry, "нет PostToolUse hook для job-notify.mjs");
  const matcher = new RegExp(entry.matcher);
  for (const producer of ["ask", "chat", "delegate", "review", "challenge", "collaborate"]) {
    assert.ok(matcher.test(`mcp__tandem__codex_${producer}`), `${producer} не совпал с matcher`);
    matcher.lastIndex = 0;
    assert.ok(matcher.test(`mcp__other-server__codex_${producer}`), `${producer} зависит от фиксированного server name`);
    matcher.lastIndex = 0;
  }
  const notifyHook = entry.hooks.find((hook) => /job-notify\.mjs/.test(hook.command || ""));
  assert.equal(notifyHook.asyncRewake, true, "job notification hook должен будить ожидающую сессию");
  assert.ok(Number(notifyHook.timeout) > 480 * 60, `timeout должен быть в секундах и превышать 480 минут: ${notifyHook.timeout}`);
});

process.stdout.write(`\n${passed}/${passed + failed} пройдено, ${skipped} пропущено\n`);
fs.rmSync(TMP, { recursive: true, force: true });
if (failed) process.exitCode = 1;
