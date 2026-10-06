// models.mjs — динамический список моделей Codex.
// Источник истины: `codex debug models` (каталог после слияния всех слоёв
// конфигурации). Ничего не хардкодим: список моделей меняется, а устаревший
// хардкод приводит к вызовам несуществующих моделей.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { codexBinary, dataDir, envClean } from "./codex-core.mjs";
import { message } from "./i18n-runtime.mjs";

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 часов
// Формат разобранной записи. Повышается вместе с разбором каталога: иначе после
// исправления парсера кэш ещё шесть часов отдавал бы прежние ошибки.
export const CACHE_VERSION = 2;
const cachePath = () => path.join(path.dirname(dataDir()), "models-cache.json");

/**
 * Уровни усилий записи. Codex отдаёт их в supported_reasoning_levels массивом
 * объектов {effort, description}; прежние имена полей оставлены как запасные.
 * Отсутствие поля означает «неизвестно», а не «модель не принимает ничего».
 */
function readEfforts(node) {
  const raw =
    node?.supported_reasoning_levels || node?.supported_reasoning_efforts || node?.reasoning_efforts || node?.efforts;
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const item of raw) {
    const v = typeof item === "string" ? item : item?.effort || item?.level || item?.id;
    if (typeof v === "string" && v && !out.includes(v)) out.push(v);
  }
  return out.length ? out : null;
}

function toEntry(node, key) {
  const id = node?.slug || node?.id || node?.model || node?.model_id || key;
  if (!id || typeof id !== "string") return null;
  return {
    id,
    label: node?.display_name || node?.label || node?.name || null,
    efforts: readEfforts(node),
    visibility: node?.visibility || null,
    default: node?.is_default === true || node?.default === true || undefined,
  };
}

/** Похоже ли на запись модели. Одного `name` мало: его носят и service_tiers. */
function looksLikeModel(n) {
  if (!n || typeof n !== "object" || Array.isArray(n)) return false;
  return Boolean(
    n.display_name ||
      n.label ||
      n.visibility ||
      Array.isArray(n.supported_reasoning_levels) ||
      Array.isArray(n.supported_reasoning_efforts) ||
      Array.isArray(n.reasoning_efforts) ||
      Array.isArray(n.efforts)
  );
}

/** Запасной разбор для форм без явного списка: форма вывода не документирована. */
function walkCatalog(payload) {
  const out = [];
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(walk);

    const id = node.slug || node.id || node.model || node.model_id;
    if (typeof id === "string" && looksLikeModel(node)) {
      const e = toEntry(node);
      if (e) out.push(e);
      return; // внутрь записи не спускаемся: там лежат service_tiers и прочее
    }
    for (const [k, v] of Object.entries(node)) {
      // Каталоги часто выглядят как { "gpt-5.6-sol": {...} }
      if (looksLikeModel(v) && /^[a-z0-9][\w.\-]*$/i.test(k)) {
        const e = toEntry(v, k);
        if (e) out.push(e);
        continue;
      }
      walk(v);
    }
  };
  walk(payload);
  return out;
}

/** Вытаскивает записи моделей из JSON-каталога. */
export function parseCatalog(payload) {
  // Явный список — единственный источник, когда он есть: прежний сплошной обход
  // принимал за модели вложенные объекты записи (service_tiers → «priority»).
  const list = Array.isArray(payload) ? payload : Array.isArray(payload?.models) ? payload.models : null;
  const entries = list ? list.map((n) => toEntry(n)).filter(Boolean) : walkCatalog(payload);

  const out = [];
  const seen = new Set();
  for (const e of entries) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
  }
  return out;
}

function readCache() {
  try {
    const c = JSON.parse(fs.readFileSync(cachePath(), "utf8"));
    if (c.v !== CACHE_VERSION) return null;
    if (Date.now() - c.at < CACHE_TTL_MS && Array.isArray(c.models) && c.models.length) return c;
  } catch {}
  return null;
}

function writeCache(models, source, complete) {
  try {
    fs.mkdirSync(path.dirname(cachePath()), { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      cachePath(),
      JSON.stringify({ v: CACHE_VERSION, at: Date.now(), source, complete, models }, null, 2),
      { mode: 0o600 }
    );
  } catch {}
}

/** Спрашивает у Codex его каталог моделей. */
export function fetchModels({ force = false } = {}) {
  if (!force) {
    const c = readCache();
    if (c) return { ok: true, models: c.models, source: c.source, complete: c.complete !== false, cached: true };
  }

  const r = spawnSync(codexBinary(), ["debug", "models"], {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
  });

  if (r.error?.code === "ENOENT") {
    return { ok: false, error: message("models_cli_not_found") };
  }

  const raw = (r.stdout || "").trim();
  if (raw) {
    // Каталог может быть окружён служебным текстом — берём первый JSON-блок.
    // Каталог может быть окружён служебными строками с обеих сторон, поэтому
    // пробуем сузить срез справа, а не только слева.
    const start = raw.search(/[[{]/);
    if (start >= 0) {
      const tail = raw.slice(start);
      // Каталог бывает массивом, а не объектом, поэтому границы ищутся по обеим
      // закрывающим скобкам сразу: прежний перебор предпочитал последнюю «}» и
      // пропускал более позднюю «]», то есть массив объектов не разбирался.
      const ends = [];
      for (let i = tail.length; i > 1; i--) {
        if (tail[i - 1] === "}" || tail[i - 1] === "]") ends.push(i);
      }
      for (const end of ends) {
        try {
          const models = parseCatalog(JSON.parse(tail.slice(0, end)));
          if (models.length) {
            writeCache(models, "codex debug models", true);
            return { ok: true, models, source: "codex debug models", complete: true };
          }
        } catch {}
      }
    }
  }

  // Запасной путь: каталог, объявленный пользователем в config.toml.
  const fromConfig = modelsFromConfig();
  if (fromConfig.length) {
    writeCache(fromConfig, "config.toml", false);
    // complete: false — это не каталог, а лишь то, что пользователь прописал
    // сам. Блокировать по нему чужие имена моделей нельзя.
    return { ok: true, models: fromConfig, source: "config.toml", complete: false, degraded: true };
  }

  const stale = (() => {
    try {
      return JSON.parse(fs.readFileSync(cachePath(), "utf8"));
    } catch {
      return null;
    }
  })();
  if (stale?.models?.length) {
    return {
      ok: true,
      models: stale.models,
      source: message("models_stale_source", stale.source),
      // Просроченный кэш — подсказка, а не каталог: он мог быть записан прежним
      // разбором и заведомо не знает моделей, появившихся после его записи.
      complete: false,
      degraded: true,
    };
  }

  return {
    ok: false,
    error: message("models_fetch_failed", r.status, (r.stderr || "").trim()),
  };
}

/** Модель и профиль, объявленные в config.toml — как подсказка и как fallback. */
export function modelsFromConfig() {
  const found = new Map();
  const files = [
    path.join(os.homedir(), ".codex", "config.toml"),
    path.join(process.cwd(), ".codex", "config.toml"),
  ];
  for (const f of files) {
    let s;
    try {
      s = fs.readFileSync(f, "utf8");
    } catch {
      continue;
    }
    for (const m of s.matchAll(/^\s*model\s*=\s*["']([^"']+)["']/gm)) {
      found.set(m[1], { id: m[1], label: null, efforts: null });
    }
  }
  return [...found.values()];
}

/**
 * Есть ли такая модель в каталоге — как справка, а не как разрешение.
 * Каталог отстаёт от реальной доступности: gpt-6-astra отвечал в `codex exec`,
 * когда `codex debug models` его ещё не перечислял, а кэш держал прежний список
 * ещё шесть часов. Поэтому вызов не блокируется — последнее слово за API.
 */
export function knownModel(id) {
  if (!id) return { known: true };
  const r = fetchModels();
  if (!r.ok) return { known: true, unverified: true };
  const hit = r.models.find((m) => m.id === id);
  if (hit) return { known: true, model: hit };
  return { known: true, unverified: true, source: r.source, available: r.models.map((m) => m.id) };
}

/**
 * Основа набора уровней усилий: то, что известно и без каталога. Конкретная
 * модель принимает лишь подмножество — gpt-5.6-sol отвергает `minimal` ошибкой
 * API, а модели прошлых поколений его принимают. Настоящую фильтрацию делает
 * каталог модели, см. effortsFor.
 */
export const EFFORT_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * Набор для схемы MCP-инструментов и для проверки: основа плюс всё, что объявил
 * каталог. Иначе новый уровень (`ultra` у gpt-5.6-sol) остаётся недоступным,
 * пока его не впишут руками. Берётся только из кэша: построение схемы не должно
 * стоить вызова `codex debug models` на старте сервера.
 */
export function effortLevels() {
  const out = [...EFFORT_LEVELS];
  for (const m of readCache()?.models || []) {
    for (const e of m.efforts || []) if (!out.includes(e)) out.push(e);
  }
  return out;
}

/** Уровни, поддерживаемые конкретной моделью, или null если неизвестно. */
export function effortsFor(id) {
  if (!id) return null;
  const r = fetchModels();
  if (!r.ok || r.complete === false) return null;
  const hit = r.models.find((m) => m.id === id);
  return Array.isArray(hit?.efforts) && hit.efforts.length ? hit.efforts : null;
}

/**
 * Проверяет уровень усилий против каталога. Блокирует только когда точно
 * известно, что модель его не примет: иначе получили бы ту же болезнь, что и
 * с зашитыми списками моделей.
 */
export function validateEffort(model, effort) {
  if (!effort) return null;
  // Тот же набор, что объявлен в схеме инструмента: расходись они, вызывающий
  // получал бы отказ на значение, которое схема ему разрешает.
  const levels = effortLevels();
  if (!levels.includes(effort)) {
    return message("effort_unknown", effort, levels);
  }
  const supported = effortsFor(model || envClean("TANDEM_MODEL"));
  if (supported && !supported.includes(effort)) {
    return message("effort_unsupported", model || envClean("TANDEM_MODEL"), effort, supported);
  }
  return null;
}

export function formatModels(r) {
  if (!r.ok) return r.error;
  const lines = r.models.map((m) => {
    const bits = [m.id];
    if (m.label && m.label !== m.id) bits.push(`— ${m.label}`);
    if (m.efforts?.length) bits.push(`[effort: ${m.efforts.join(", ")}]`);
    else bits.push(message("models_effort_missing"));
    if (m.default) bits.push(message("models_default"));
    return "  " + bits.join(" ");
  });
  return [
    message("models_header", r.source, r.cached),
    ...lines,
    r.complete === false
      ? message("models_incomplete")
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}
