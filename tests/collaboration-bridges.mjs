import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { McpStdioClient } from "../bridge/mcp-client.mjs";

const root = path.resolve(import.meta.dirname, "..");

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tandem-collaboration-bridges-"));
  const cli = path.join(dir, "cli.mjs");
  const preload = path.join(dir, "preload.mjs");
  const log = path.join(dir, "calls.jsonl");
  const workspace = path.join(dir, "workspace");
  fs.mkdirSync(workspace);
  const exposed = path.join(dir, "exposed.json");
  fs.writeFileSync(exposed, '{"servers":{},"allow_task":false}');
  fs.writeFileSync(cli, `
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('codex 0.0.0-test'); process.exit(0); }
if (args[0] === 'login') { console.log('Logged in using test'); process.exit(0); }
if (args[0] === 'exec' && args[1] === '--help') {
  console.log('Usage: codex exec --sandbox --json --cd --skip-git-repo-check'); process.exit(0);
}
if (args[0] === 'mcp') {
  if (process.env.COLLAB_BAD_MCP === '1') { console.log('sensitive-invalid-data'); process.exit(0); }
  console.log(JSON.stringify([{name:'claude-bridge'}, {name:'another.server'}])); process.exit(0);
}
const prompt = fs.readFileSync(0, 'utf8');
fs.appendFileSync(process.env.COLLAB_TEST_LOG, JSON.stringify({args,prompt,cwd:process.cwd(),nested:process.env.TANDEM_COLLABORATION_CHILD})+'\\n');
if (process.env.COLLAB_DELAY) await new Promise((resolve) => setTimeout(resolve, Number(process.env.COLLAB_DELAY)));
if (args[0] === '-p' && process.env.COLLAB_CLAUDE_MODE === 'error') console.log(JSON.stringify({type:'result',subtype:'error_max_turns',is_error:true}));
else if (args[0] === '-p' && process.env.COLLAB_CLAUDE_MODE === 'empty') console.log(JSON.stringify({type:'result',is_error:false,result:'  '}));
else if (args[0] === '-p' && args.includes('json')) console.log(JSON.stringify({type:'result',is_error:false,result:'CLAUDE contribution',usage:{input_tokens:10,output_tokens:5,cache_creation_input_tokens:100,cache_read_input_tokens:9000}}));
else if (args[0] === '-p') console.log('CLAUDE contribution');
else {
  console.log(JSON.stringify({type:'thread.started',thread_id:'11111111-1111-1111-1111-111111111111'}));
  console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'CODEX contribution'}}));
  console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:12,cached_input_tokens:2,output_tokens:5}}));
}
`);
  fs.writeFileSync(preload, `
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {promisify} from 'node:util';
for (const method of ['spawn','spawnSync','execFile']) {
  const original = cp[method];
  cp[method] = function(file,args,...rest) {
    if (file === 'tandem-fake-codex' || file === 'tandem-fake-claude') {
      return original.call(this, process.execPath, [${JSON.stringify(cli)}, ...args], ...rest);
    }
    return original.call(this,file,args,...rest);
  };
}
cp.execFile[promisify.custom] = (file, args, options) => new Promise((resolve, reject) => {
  cp.execFile(file, args, options, (error, stdout, stderr) => error ? reject(error) : resolve({stdout,stderr}));
});
syncBuiltinESMExports();
`);
  const clients = [];
  t.after(async () => {
    for (const client of clients) {
      const child = client.child;
      const closed = child?.exitCode !== null ? Promise.resolve() : new Promise((resolve) => child.once("close", resolve));
      client.stop();
      await closed;
    }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return {
    dir: workspace,
    calls: () => fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [],
    async client(backend, extraEnv = {}) {
      const client = new McpStdioClient({
        alias: backend,
        command: process.execPath,
        args: [path.join(root, backend === "codex" ? "scripts" : "bridge", `mcp-${backend}.mjs`)],
        cwd: workspace,
        env: {
          NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
          CODEX_BIN: "tandem-fake-codex",
          CLAUDE_BIN: "tandem-fake-claude",
          CLAUDE_PLUGIN_DATA: path.join(dir, "data"),
          TANDEM_EXPOSED: exposed,
          TANDEM_CWD: workspace,
          TANDEM_LANG: "en",
          TANDEM_BYPASS_SANDBOX: "false",
          TANDEM_COLLABORATION_CHILD: "",
          TANDEM_MODEL: "",
          TANDEM_EFFORT: "",
          COLLAB_TEST_LOG: log,
          ...extraEnv,
        },
        timeoutMs: 15_000,
      });
      clients.push(client);
      await client.start();
      return client;
    },
  };
}

function payload(result) {
  assert.equal(result.isError, undefined, JSON.stringify(result));
  return JSON.parse(result.content[0].text);
}

for (const backend of ["codex", "claude"]) {
  test(`${backend}: MCP exposes persistent collaboration and legacy tools`, async (t) => {
    const f = fixture(t);
    const client = await f.client(backend);
    const descriptor = client.tools.find((tool) => tool.name === `${backend}_collaborate`);
    assert.ok(descriptor);
    assert.ok(client.tools.some((tool) => tool.name === `${backend}_ask`));
    assert.equal(descriptor.inputSchema.properties.write, undefined);
    const first = payload(await client.call(`${backend}_collaborate`, {
      session: "joint",
      mode: "research",
      message: "Explore alternatives",
    }));
    assert.equal(first.roundsUsed, 1);
    const resumed = await f.client(backend);
    const status = payload(await resumed.call(`${backend}_collaborate`, { session: "joint", action: "status" }));
    assert.equal(status.roundsUsed, 1);
    const final = payload(await resumed.call(`${backend}_collaborate`, {
      session: "joint", phase: "synthesize", message: "Combine the findings",
    }));
    assert.equal(final.status, "complete");
    assert.equal(final.roundsUsed, 2);
    assert.deepEqual(final.tokens, { used: backend === "codex" ? 30 : 230, max: null, estimated: false, remaining: null });
    assert.equal(final.latest.reply, backend === "codex" ? "CODEX contribution" : "CLAUDE contribution");
    const calls = f.calls();
    assert.equal(calls.length, 2);
    assert.ok(calls[1].prompt.includes(backend === "codex" ? "CODEX contribution" : "CLAUDE contribution"));
    assert.equal(calls[0].cwd, f.dir);
    assert.equal(calls[0].nested, "1");
    if (backend === "codex") {
      assert.equal(calls[0].args[calls[0].args.indexOf("--sandbox") + 1], "read-only");
      assert.ok(calls[0].args.includes("features.multi_agent=false"));
      assert.ok(calls[0].args.includes('mcp_servers."claude-bridge".enabled=false'));
      assert.ok(calls[0].args.includes('mcp_servers."another.server".enabled=false'));
      assert.ok(calls[0].args.includes('features.hooks=false'));
      assert.ok(!calls[0].args.includes("--dangerously-bypass-approvals-and-sandbox"));
    } else {
      assert.ok(calls[0].args.includes("--strict-mcp-config"));
      assert.ok(calls[0].args.includes('{"mcpServers":{}}'));
      assert.ok(calls[0].args.includes('{"disableAllHooks":true}'));
      assert.equal(calls[0].args[calls[0].args.indexOf("--tools") + 1], "Read,Grep,Glob");
      assert.equal(calls[0].args[calls[0].args.indexOf("--permission-mode") + 1], "plan");
      assert.equal(calls[0].args[calls[0].args.indexOf("--output-format") + 1], "json");
      assert.equal(calls[0].args[calls[0].args.indexOf("--output-format") + 1], "json");
    }
  });

  test(`${backend}: nested bridge invocation refuses before launch`, async (t) => {
    const f = fixture(t);
    const client = await f.client(backend, { TANDEM_COLLABORATION_CHILD: "1" });
    const result = await client.call(`${backend}_collaborate`, {session: "nested", mode: "custom", message: "work"});
    assert.equal(result.isError, true);
    assert.equal(f.calls().length, 0);
  });
}

test("codex: bypass is rejected before a session or round is created", async (t) => {
  const f = fixture(t);
  const client = await f.client("codex", { TANDEM_BYPASS_SANDBOX: "true" });
  const result = await client.call("codex_collaborate", {session: "unsafe", mode: "custom", message: "work"});
  assert.ok(JSON.stringify(result).includes("TANDEM_BYPASS_SANDBOX"));
  assert.equal(f.calls().length, 0);
  const status = await client.call("codex_collaborate", {session: "unsafe", action: "status"});
  assert.equal(status.isError, true);
  assert.match(status.content[0].text, /not found/i);
});

test("codex: pending round survives another bridge and never launches twice", async (t) => {
  const f = fixture(t);
  const client = await f.client("codex", { COLLAB_DELAY: "2500" });
  const pending = payload(await client.call("codex_collaborate", {
    session: "slow", mode: "custom", message: "Investigate", wait_seconds: 1,
  }));
  assert.equal(pending.status, "pending");
  const resumed = await f.client("codex");
  const status = payload(await resumed.call("codex_collaborate", {
    session: "slow", action: "status", wait_seconds: 5,
  }));
  assert.notEqual(status.status, "pending");
  assert.equal(status.roundsUsed, 1);
  assert.equal(f.calls().length, 1);
});

test("codex: malformed MCP listing fails closed without leaking configuration", async (t) => {
  const f = fixture(t);
  const client = await f.client("codex", { COLLAB_BAD_MCP: "1" });
  const result = await client.call("codex_collaborate", {session: "bad-list", mode: "research", message: "work"});
  assert.ok(JSON.stringify(result).includes("codex mcp list --json"));
  assert.ok(!JSON.stringify(result).includes("sensitive-invalid-data"));
  assert.equal(f.calls().length, 0);
});

for (const mode of ["error", "empty"]) {
  test(`claude: ${mode} JSON result fails the round instead of completing a phase`, async (t) => {
    const f = fixture(t);
    const client = await f.client("claude", { COLLAB_CLAUDE_MODE: mode });
    const snapshot = payload(await client.call("claude_collaborate", { session: mode, mode: "compare", message: "Solve", commitment: "host answer" }));
    assert.equal(snapshot.status, "active");
    assert.equal(snapshot.phase, "solve");
    assert.equal(snapshot.latest.reply, null);
    assert.ok(snapshot.latest.error);
    const next = await client.call("claude_collaborate", { session: mode, phase: "compare", message: "Compare" });
    assert.equal(next.isError, true, "a failed solve must not satisfy the compare prerequisite");
  });
}
