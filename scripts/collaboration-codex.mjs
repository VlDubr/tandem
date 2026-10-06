// Адаптер совместной работы: существующие задачи Codex без повторного запуска при опросе.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  bypassSandboxEnabled,
  capabilities,
  codexBinary,
  startJob,
  followJob,
  jobResult,
  cancelJob,
} from "./codex-core.mjs";
import { collaborationMessage } from "./i18n-collaboration.mjs";

const execFileAsync = promisify(execFile);

export async function collaborationConfig(cwd) {
  if (bypassSandboxEnabled()) throw new Error(collaborationMessage("bypass"));
  if (!capabilities().sandbox) throw new Error(collaborationMessage("unsupported_sandbox"));

  let servers;
  try {
    const { stdout } = await execFileAsync(codexBinary(), ["mcp", "list", "--json"], {
      cwd,
      timeout: 8_000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    });
    servers = JSON.parse(stdout);
    if (!Array.isArray(servers) || servers.some((server) => typeof server?.name !== "string" || !server.name)) {
      throw new Error("Invalid MCP server list");
    }
  } catch {
    // Вывод списка может содержать окружение серверов: не включаем его в ошибку.
    throw new Error(collaborationMessage("mcp_config", "codex mcp list --json"));
  }

  return servers.map((server) => server.name);
}

export function createCodexCollaborationRunner(cwd, onEvent) {
  const result = (jobId) => {
    const r = jobResult(jobId);
    if (r.running) return { pending: true, jobId };
    return r.ok ? { ok: true, output: r.output } : { ok: false, error: r.error };
  };

  const wait = async (jobId, seconds, ctx) => {
    // Длинное ожидание держит MCP-вызов дольше таймаута клиента: потолок 120 с.
    const bounded = Math.min(120, Math.max(1, Number(seconds) || 90));
    const r = await followJob(jobId, {
      timeoutMs: bounded * 1000,
      onEvent,
      signal: ctx.signal,
    });
    if (r.aborted) {
      cancelJob(jobId);
      return { ok: false, error: collaborationMessage("cancelled") };
    }
    return r.finished ? result(jobId) : { pending: true, jobId };
  };

  return {
    async start(prompt, options, ctx) {
      if (process.env.TANDEM_COLLABORATION_CHILD === "1") {
        throw new Error(collaborationMessage("nested"));
      }
      const disabledMcpServers = await collaborationConfig(cwd);
      if (ctx.signal?.aborted) return { ok: false, error: collaborationMessage("cancelled") };
      const job = startJob({
        mode: "collaborate",
        prompt,
        cwd,
        model: options.model,
        effort: options.effort,
        sandbox: "read-only",
        disabledMcpServers,
        collaborationChild: true,
      });
      try {
        await ctx.onStarted(job.id);
      } catch (error) {
        cancelJob(job.id);
        throw error;
      }
      return wait(job.id, options.wait_seconds ?? 90, ctx);
    },
    async poll(jobId, options, ctx) {
      return options.wait_seconds ? wait(jobId, options.wait_seconds, ctx) : result(jobId);
    },
    cancel(jobId) {
      cancelJob(jobId);
    },
  };
}
