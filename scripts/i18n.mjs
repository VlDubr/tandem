// i18n.mjs — тексты, которые видят пользователь и вызываемая модель.
//
// Зачем: плагин писался на русском целиком, включая промпты. Промпт на русском
// заставляет и Codex, и Claude отвечать по-русски, поэтому для нерусскоязычного
// пользователя это был не «плагин с русской документацией», а плагин, меняющий
// язык вывода. Английский стал языком по умолчанию, русский включается
// настройкой.
//
// Здесь только наружные строки. Комментарии в коде остаются русскими: их видит
// автор, а не пользователь.

const LANGS = new Set(["en", "ru"]);

/** Язык интерфейса. Значение вне набора игнорируется — молча падать некуда. */
export function lang() {
  const v = process.env.TANDEM_LANG;
  const t = typeof v === "string" ? v.trim().toLowerCase() : "";
  return LANGS.has(t) ? t : "en";
}

const PROMPTS = {
  en: {
    review: (diff, extra) => `You are acting as a code reviewer. Work read-only: change nothing.

Review the changes below thoroughly. Split your output into:
1. Blockers — things that must not be merged.
2. Important — bugs, holes, races, leaks, unhandled failures.
3. Minor — style, naming, dead code.

For every item give file:line and a concrete suggestion. If the diff alone is not enough, read the files in the repository. Do not praise code that does not deserve it; an empty section beats filler.
${extra ? `\nExtra focus requested by the user: ${extra}\n` : ""}
The context below is split into sections. The "Not committed yet" section holds edits absent from the branch commits: their status differs from the rest, so account for that in your findings. Where a patch is replaced by an instruction to read the files yourself, read them — do not guess.

=== REVIEW CONTEXT ===
${diff || "(no changes found — inspect the working tree yourself)"}`,

    challenge: (diff, focus) => `You are acting as an adversarial reviewer. Your job is not to find typos but to challenge the decision.

Work read-only. Answer:
- Which implicit assumptions are baked into this design, and what happens when they do not hold?
- Which failure mode did the authors not consider? (races, partial rollback, data loss, retries, dependency degradation)
- Is there a fundamentally simpler or safer approach? If so, describe it and state honestly where it is worse.
- What breaks under 100x load or during a release rollback?

Do not agree out of politeness. If the decision is genuinely sound, say so plainly and name the conditions under which it stops being sound.
${focus ? `\nThe user asks you to focus on: ${focus}\n` : ""}
The context below is split into sections. The "Not committed yet" section holds edits absent from the branch commits: their status differs from the rest, so account for that in your findings. Where a patch is replaced by an instruction to read the files yourself, read them — do not guess.

=== REVIEW CONTEXT ===
${diff || "(no changes found — inspect the working tree yourself)"}`,

    delegate: (task) => `A task in this repository has been delegated to you. You may read and change files, run tests and build commands.

TASK:
${task}

How to work:
1. Find the cause, not the symptom. Show what backs the diagnosis.
2. Make the smallest safe change.
3. Check yourself: run the relevant tests or linter if they exist.
4. Finish with a summary: what was wrong, what you changed (list of files), how you verified it, what is still open.

Do not rewrite what nobody asked about. If the task is ambiguous, pick a reasonable reading and name it explicitly in the summary.`,

    ask: (question, context) => `Another model (Claude), working on a task in this repository, is asking you for a second opinion.

${context ? `CONTEXT FROM CLAUDE:\n${context}\n\n` : ""}QUESTION:
${question}

Answer to the point and concisely. You may read repository files to check facts. If you disagree with the premise of the question, say so plainly — that is worth more than polite agreement. Where you are unsure, state your confidence.`,

    chat: (message, context) => `A user is starting a conversation with you through Claude Code: the bridge relays their messages, and you answer as a model in your own right. The conversation continues in this same thread, so keep the context.

${context ? `CONTEXT:\n${context}\n\n` : ""}MESSAGE:
${message}

Answer to the point and concisely. You may read repository files. If the message is ambiguous, ask rather than guess.`,
  },

  ru: {
    review: (diff, extra) => `Ты выступаешь ревьюером кода. Работай только на чтение: ничего не меняй.

Проведи тщательное ревью изменений ниже. Разбей вывод на:
1. Блокеры — то, что нельзя мержить.
2. Важное — баги, дыры, гонки, утечки, неучтённые ошибки.
3. Мелочи — стиль, именование, мёртвый код.

Для каждого пункта дай файл:строку и конкретное предложение. Если что-то непонятно из дифа — прочитай нужные файлы в репозитории. Не хвали код, если хвалить не за что; пустая секция лучше воды.
${extra ? `\nДополнительный фокус от пользователя: ${extra}\n` : ""}
Контекст ниже разбит на разделы. Раздел «Ещё не закоммичено» — правки, которых нет в коммитах ветки: их состояние отличается от остального, учитывай это в замечаниях. Если вместо патча стоит указание дочитать самому — читай файлы, не додумывай.

=== КОНТЕКСТ РЕВЬЮ ===
${diff || "(изменений не найдено — посмотри рабочее дерево сам)"}`,

    challenge: (diff, focus) => `Ты выступаешь состязательным ревьюером. Твоя задача — не найти опечатки, а оспорить решение.

Работай только на чтение. Ответь на:
- Какие неявные допущения зашиты в этот дизайн и что будет, если они не выполнятся?
- Какой сценарий отказа авторы не рассмотрели? (гонки, частичный откат, потеря данных, ретраи, деградация зависимостей)
- Существует ли принципиально более простой или более безопасный подход? Если да — опиши его и честно назови, чем он хуже.
- Что сломается при 100x нагрузке или при откате релиза?

Не соглашайся из вежливости. Если решение действительно хорошее — скажи это прямо и укажи, при каких условиях оно перестанет быть хорошим.
${focus ? `\nПользователь просит сфокусироваться на: ${focus}\n` : ""}
Контекст ниже разбит на разделы. Раздел «Ещё не закоммичено» — правки, которых нет в коммитах ветки: их состояние отличается от остального, учитывай это в замечаниях. Если вместо патча стоит указание дочитать самому — читай файлы, не додумывай.

=== КОНТЕКСТ РЕВЬЮ ===
${diff || "(изменений не найдено — посмотри рабочее дерево сам)"}`,

    delegate: (task) => `Тебе делегирована задача в этом репозитории. Ты можешь читать и изменять файлы, запускать тесты и команды сборки.

ЗАДАЧА:
${task}

Порядок работы:
1. Сначала разберись в причине, а не в симптоме. Покажи, чем подтверждается диагноз.
2. Сделай минимальное безопасное изменение.
3. Проверь себя: запусти релевантные тесты или линтер, если они есть.
4. В конце выдай сводку: что было не так, что изменил (список файлов), как проверил, что осталось незакрытым.

Не переписывай то, о чём не просили. Если задача сформулирована неоднозначно — выбери разумную трактовку и явно назови её в сводке.`,

    ask: (question, context) => `К тебе обращается другая модель (Claude), работающая над задачей в этом репозитории. Она просит второе мнение.

${context ? `КОНТЕКСТ ОТ CLAUDE:\n${context}\n\n` : ""}ВОПРОС:
${question}

Ответь по существу и сжато. Можешь читать файлы репозитория, чтобы проверить факты. Если ты не согласен с посылкой вопроса — скажи об этом прямо, это ценнее вежливого согласия. Если уверенности нет — обозначь степень уверенности.`,

    chat: (message, context) => `С тобой начинает разговор пользователь через Claude Code: его сообщения передаёт мост, а ты отвечаешь как самостоятельная модель. Разговор продолжится в этом же треде, поэтому помни контекст.

${context ? `КОНТЕКСТ:\n${context}\n\n` : ""}СООБЩЕНИЕ:
${message}

Отвечай по существу и сжато. Можешь читать файлы репозитория. Если сообщение неоднозначно — уточни, а не угадывай.`,
  },
};

// Описания инструментов и их параметров. Это первое, что читает модель, решая,
// звать инструмент или нет, поэтому формулировки здесь важнее стилистики.
const TOOLS = {
  en: {
    effort:
      "Reasoning level. The available set depends on the model: codex_models returns the exact list. Only earlier-generation models accept minimal — gpt-5.6 and newer reject it with an API error.",

    ask_d: "Ask GPT (Codex) for a second opinion synchronously and get the answer in this same turn. Use it to sanity-check an architectural decision, test your own hypothesis, or get a counterargument before writing code. Answers within 1-3 minutes.",
    ask_question: "The question for GPT, phrased so it stands on its own.",
    ask_context: "Your current context: what you already found out, what you propose, what you doubt. The more concrete, the more useful the answer.",
    ask_model: "Codex model, e.g. gpt-5.6-sol or gpt-5.4-mini.",
    ask_wait: "How long to wait for a synchronous answer. If Codex does not finish in time the call does not fail: the very same work continues in the same process in the background and a job_id is returned along with the progress trail — follow it with codex_progress.",

    chat_d: "Talk to a Codex model as a separate interlocutor: the thread persists and the model remembers earlier messages. Use it when you need a dialogue rather than a one-off question, or when a specific GPT model is carrying the task.",
    chat_message: "Message for the model.",
    chat_chat: "Conversation name (latin letters, digits, hyphen). One name is one continuous thread. Defaults to default.",
    chat_model: "Codex model for this conversation. Set on the first message and reused automatically afterwards.",
    chat_context: "Extra context for the first message of the conversation.",
    chat_write: "Allow the model to change files in the working directory. Read-only by default.",
    chat_wait: "How long to wait for the answer in this same turn.",

    chats_d: "List conversations with Codex models; a conversation can be forgotten together with its thread.",
    chats_forget: "Name of the conversation to forget.",

    use_d: "Pick the default model and reasoning level for this repository. Applies to later calls that do not name a model explicitly.",
    use_model: "Codex model. An empty string resets to the plugin setting.",
    use_clear: "Reset both the model and the reasoning level.",

    review_d: "Run an ordinary GPT code review of the current changes. Runs in the background by default.",
    review_base: "Base branch for reviewing the whole branch, e.g. main. Branch commits and uncommitted work are collected separately.",
    review_focus: "Optional extra focus.",

    challenge_d: "Adversarial review: GPT challenges a design decision, hunts for failure modes nobody accounted for, and proposes alternatives. Use it before merging a large change.",
    challenge_focus: "What exactly to challenge: 'the retry scheme', 'the cache choice', 'the permission model'.",

    delegate_d:
      "Delegate a task to GPT with permission to change files: investigate a bug, fix a test, refactor a piece. " +
      "Shows the progress trail while it waits; if GPT does not finish in time the work continues in the background and a job_id is returned.",
    delegate_task: "Description of the task for GPT, as concrete as possible.",
    delegate_wait:
      "How long to wait while showing GPT's progress trail. Zero goes to the background immediately and returns a job_id. " +
      "When the time runs out the call does not fail: the very same work continues in the same process.",

    models_d: "Get the list of models actually available in this Codex installation. Asks Codex itself instead of using a hardcoded list. Call this before naming a model in other tools if you are unsure of the name.",
    models_refresh: "Ignore the cache and re-read the catalogue.",

    progress_d: "Show what the model is doing right now: the trail of its reasoning, commands it ran, files it edited, searches it made. Use it instead of waiting blindly when a task runs long.",
    progress_job: "Defaults to the most recent task.",
    progress_limit: "How many of the latest steps to show.",
    progress_detail: "Show reasoning summaries in full.",
    progress_wait: "Wait this many seconds for new events, showing them as they appear.",

    status_d: "Show the status of background Codex tasks for the current repository.",
    status_job: "Optional: a specific task.",

    result_d: "Get the final output of a finished background Codex task.",
    result_job: "Optional: defaults to the most recent task.",
    result_tail: "Return only the last N lines.",

    cancel_d: "Cancel a running background Codex task.",
  },

  ru: {
    effort:
      "Уровень reasoning. Набор зависит от модели: точный список отдаёт codex_models. Значение minimal принимают только модели прошлых поколений — gpt-5.6 и новее отвергают его ошибкой API.",

    ask_d: "Спросить у GPT (Codex) второе мнение синхронно и получить ответ в этом же ходе. Используй, когда нужно сверить архитектурное решение, проверить свою гипотезу или получить контраргумент перед тем, как писать код. Отвечает за 1-3 минуты.",
    ask_question: "Вопрос к GPT, сформулированный самодостаточно.",
    ask_context: "Твой текущий контекст: что ты уже выяснил, какое решение предлагаешь, какие есть сомнения. Чем конкретнее, тем полезнее ответ.",
    ask_model: "Модель Codex, напр. gpt-5.6-sol или gpt-5.4-mini.",
    ask_wait: "Сколько ждать синхронного ответа. Если Codex не успеет, вызов не падает по таймауту: та же самая работа продолжается тем же процессом в фоне и возвращается job_id вместе с лентой прогресса — дальше следи через codex_progress.",

    chat_d: "Поговорить с моделью Codex как с отдельным собеседником: тред сохраняется, модель помнит предыдущие сообщения. Используй, когда нужен диалог, а не одиночный вопрос, или когда задачу ведёт конкретная модель GPT.",
    chat_message: "Сообщение модели.",
    chat_chat: "Имя разговора (латиница, цифры, дефис). Одно имя — один непрерывный тред. По умолчанию default.",
    chat_model: "Модель Codex для этого разговора. Задаётся на первом сообщении и дальше повторяется сама.",
    chat_context: "Дополнительный контекст к первому сообщению разговора.",
    chat_write: "Разрешить модели менять файлы в рабочем каталоге. По умолчанию только чтение.",
    chat_wait: "Сколько ждать ответа в этом же ходе.",

    chats_d: "Список разговоров с моделями Codex; можно забыть разговор вместе с его тредом.",
    chats_forget: "Имя разговора, который надо забыть.",

    use_d: "Выбрать модель и уровень reasoning по умолчанию для этого репозитория. Действует на последующие вызовы, у которых модель не указана явно.",
    use_model: "Модель Codex. Пустая строка — сброс к настройке плагина.",
    use_clear: "Сбросить и модель, и уровень reasoning.",

    review_d: "Запустить обычное ревью кода силами GPT по текущим изменениям. По умолчанию в фоне.",
    review_base: "Базовая ветка для ревью всей ветки, напр. main. Коммиты ветки и незакоммиченное собираются раздельно.",
    review_focus: "Опциональный дополнительный фокус.",

    challenge_d: "Состязательное ревью: GPT оспаривает дизайн-решение, ищет неучтённые режимы отказа и предлагает альтернативы. Используй перед мержем крупного изменения.",
    challenge_focus: "Что именно оспорить: 'схема ретраев', 'выбор кеша', 'модель прав доступа'.",

    delegate_d:
      "Делегировать GPT задачу с правом изменять файлы: исследовать баг, починить тест, отрефакторить кусок. " +
      "Показывает ленту хода работы, пока ждёт; если GPT не уложился, работа продолжается в фоне и возвращается job_id.",
    delegate_task: "Описание задачи для GPT, максимально конкретное.",
    delegate_wait:
      "Сколько ждать с показом ленты действий GPT. Ноль — сразу уйти в фон и вернуть job_id. " +
      "По истечении вызов не падает: та же работа продолжается тем же процессом.",

    models_d: "Получить список моделей, реально доступных в этом окружении Codex. Спрашивает у самого Codex, а не берёт из зашитого списка. Вызови это, прежде чем указывать model в других инструментах, если не уверен в имени.",
    models_refresh: "Игнорировать кэш и перечитать каталог.",

    progress_d: "Показать, чем модель занята прямо сейчас: лента её рассуждений, запущенных команд, правок файлов и поисков. Используй вместо ожидания вслепую, когда задача идёт долго.",
    progress_job: "По умолчанию последняя задача.",
    progress_limit: "Сколько последних шагов показать.",
    progress_detail: "Показать сводки размышлений целиком.",
    progress_wait: "Подождать новые события столько секунд, показывая их по мере появления.",

    status_d: "Показать статус фоновых задач Codex для текущего репозитория.",
    status_job: "Опционально: конкретная задача.",

    result_d: "Получить финальный вывод завершённой фоновой задачи Codex.",
    result_job: "Опционально: по умолчанию последняя задача.",
    result_tail: "Вернуть только последние N строк.",

    cancel_d: "Отменить выполняющуюся фоновую задачу Codex.",
  },
};

/**
 * Тексты инструментов на текущем языке. Английский подставляется под каждый
 * недостающий ключ: пустое описание инструмента хуже описания на чужом языке.
 */
export function toolText() {
  return { ...TOOLS.en, ...(TOOLS[lang()] || {}) };
}

// Лента хода работы: короткие глаголы, которыми описывается каждый шаг модели.
const TRAIL = {
  en: {
    session_open: "session opened",
    turn_started: "started thinking",
    done: (bits) => `finished${bits ? ` (${bits} tokens)` : ""}`,
    tokens_in: (n) => `in ${n}`,
    tokens_out: (n) => `out ${n}`,
    tokens_reasoning: (n) => `reasoning ${n}`,
    no_detail: "no details",
    failure: (m) => `failure: ${m}`,
    reconnecting: (m) => `reconnecting (${m})`,
    error: (m) => `error: ${m}`,
    warning: (m) => `warning: ${m}`,
    reasoning: (m) => `thinking: ${m}`,
    running: (c) => `running: ${c}`,
    ran: (c, code) => `ran: ${c}${code === null ? "" : ` (exit ${code})`}`,
    editing_files: (f) => (f ? `editing files: ${f}` : "editing files"),
    tool_call: (started, name) => `${started ? "calling" : "called"} tool: ${name}`,
    web_search: (q) => `searching the web: ${q}`,
    plan: (done, total) => `plan: ${done}/${total} done`,
    subagent: (started, name) => `${started ? "handing to" : "got back from"} subagent: ${name}`,
    subagent_default: "subagent",
    composing: "composing the answer",
    asks: (q) => `asks: ${q}`,
    says: (m) => `says: ${m}`,
    truncated: "[… truncated]",
  },
  ru: {
    session_open: "сессия открыта",
    turn_started: "начал обдумывать задачу",
    done: (bits) => `завершил${bits ? ` (${bits} токенов)` : ""}`,
    tokens_in: (n) => `вход ${n}`,
    tokens_out: (n) => `выход ${n}`,
    tokens_reasoning: (n) => `размышления ${n}`,
    no_detail: "без описания",
    failure: (m) => `сбой: ${m}`,
    reconnecting: (m) => `переподключение (${m})`,
    error: (m) => `ошибка: ${m}`,
    warning: (m) => `предупреждение: ${m}`,
    reasoning: (m) => `размышляет: ${m}`,
    running: (c) => `запускает: ${c}`,
    ran: (c, code) => `выполнил: ${c}${code === null ? "" : ` (код ${code})`}`,
    editing_files: (f) => (f ? `правит файлы: ${f}` : "правит файлы"),
    tool_call: (started, name) => `${started ? "вызывает" : "вызвал"} инструмент: ${name}`,
    web_search: (q) => `ищет в вебе: ${q}`,
    plan: (done, total) => `план: ${done}/${total} выполнено`,
    subagent: (started, name) => `${started ? "передаёт" : "получил от"} субагента: ${name}`,
    subagent_default: "субагент",
    composing: "формулирует ответ",
    asks: (q) => `спрашивает: ${q}`,
    says: (m) => `говорит: ${m}`,
    truncated: "[… обрезано]",
  },
};

/** Подписи ленты хода работы на текущем языке. */
export function trailText() {
  return { ...TRAIL.en, ...(TRAIL[lang()] || {}) };
}

// Ответы и отказы инструментов основного сервера.
const UI = {
  en: {
    not_installed: "Codex CLI not found. Install it: npm install -g @openai/codex — then run codex login.",
    not_logged_in: "Codex is installed but not authorised. Run in a terminal: codex login (OAuth sign-in with a ChatGPT account).",
    probe_timeout: "The Codex readiness check did not finish in time. Codex itself may well be fine. Check by hand: codex login status.",

    job_finished_ago: (age) => `${age} ago, finished`,
    job_running_for: (age) => `running for ${age}`,
    trail_truncated: "  · […trail truncated, full log via codex_progress]",
    trail_header: "GPT progress (summaries, not full reasoning):",
    answer_header: "GPT answer:",

    effort_hint: (bad) => `${bad}\nFull list — the codex_models tool.`,
    model_unverified: (model, available) =>
      `Model "${model}" is not in the Codex catalogue — running it anyway, Codex has the final say. ` +
      `Listed: ${available}\nIf the name is wrong, the call will fail with an API error. Refresh the list — the codex_models tool.`,

    cancelled: (id) => `Call cancelled, task ${id} stopped.`,
    cancelled_chat: (id, slug) => `Call cancelled, task ${id} stopped. Thread "${slug}" left unchanged.`,
    timed_out: (sec, id) => `GPT did not finish within ${sec}s — the very same work continues in the background: ${id}`,
    follow_answer: "Follow the progress: codex_progress. Collect the answer: codex_result.",
    follow_result: "Follow the progress: codex_progress. Collect the result: codex_result.",

    need_message: "The message field is required.",
    need_task: "The task field is required.",
    bad_chat_name: (slug) => `Invalid chat name: ${slug}. Latin letters, digits, dot and hyphen are allowed.`,
    chat_timed_out: (sec, id, slug) =>
      `The model did not finish within ${sec}s — the work continues in the background: ${id}\n` +
      `The answer will land in thread "${slug}" — collect it with codex_result, then carry on with the conversation.`,
    chat_thread_lost: (slug, threadId, error) =>
      `Thread "${slug}" (${threadId}) could not be resumed — Codex did not find it.\n` +
      `The session may have been deleted, or it was recorded under a different CODEX_HOME.\n` +
      `Forget the conversation (codex_chats with forget: "${slug}") and start over.\n\n${error}`,
    chat_head: (slug, model, turn, noThread) =>
      `Chat "${slug}"${model ? ` · ${model}` : ""} · turn ${turn}` +
      (noThread ? "\n(thread not saved: Codex reported no session id — the next turn will start the conversation over)" : ""),
    chat_forgotten: (slug) => `Conversation "${slug}" forgotten. The next message will start a new thread.`,
    chat_not_found: (slug) => `Conversation "${slug}" not found.`,
    no_chats: "No conversations with Codex models yet.",
    chat_line: (slug, model, effort, turns, age, noThread, cwd) =>
      `${slug}${model ? ` · ${model}` : ""}${effort ? ` · ${effort}` : ""} — ${turns} turns, ` +
      `updated ${age} ago${noThread ? " (thread not saved)" : ""}\n    ${cwd}`,

    prefs_cleared: "Reset. The plugin settings apply from now on.",
    prefs_current: (model, effort) =>
      `For this repository: model ${model}, effort ${effort}.\n` +
      `This is a per-project value, not a per-window one: an MCP call has no reliable session identifier.`,
    prefs_set: (model, effort, repo) =>
      `Defaults from now on: model ${model}, effort ${effort}.\nApplies to repository ${repo}, not just to this Claude window.`,
    from_settings: "(from plugin settings)",

    job_not_found: "Task not found. The list — codex_status.",
    job_not_found_id: (id) => `Task ${id} not found.`,
    no_jobs: "No background Codex tasks in this repository.",
    no_events_yet: (id, status, age) =>
      `${id} [${status}] — no events yet (${age} since start).\n` +
      `If Codex runs without --json support the trail is unavailable; use codex_result once it finishes.`,
    progress_head: (id, status, age) => `${id} [${status}], running for ${age}`,
    progress_finished: "\n\nWork finished — collect the result with codex_result.",
    still_running: (id, age) => `${id} is still running (${age}).`,
    trail_section: "--- progress ---",
    empty_output: "(output empty)",
    empty_so_far: "(nothing yet)",

    diff_failed: (reason) => `Could not collect the changes for review: ${reason}`,
    review_timed_out: (id) => `Did not finish within 8 minutes — the work continues in the background: ${id}`,
    review_started: (adversarial, id) =>
      `Started ${adversarial ? "adversarial review" : "review"} in the background: ${id}\n` +
      `Follow it: codex_progress. Collect the result: codex_result.`,
    delegated: (id) => `Task delegated to GPT: ${id}\nGPT works in the working directory and may change files. Follow it: codex_progress.`,
    cancelled_note: "cancelled.",
    unknown_tool: (name) => `Unknown tool: ${name}`,
    age_seconds: (n) => `${n}s`,
    age_minutes: (n) => `${n}m`,
    age_hours: (n) => `${n}h`,
  },

  ru: {
    not_installed: "Codex CLI не найден. Установи: npm install -g @openai/codex — затем codex login.",
    not_logged_in: "Codex установлен, но не авторизован. Выполни в терминале: codex login (вход через ChatGPT-аккаунт по OAuth).",
    probe_timeout: "Проверка готовности Codex не завершилась за отведённое время. Сам Codex при этом может быть исправен. Проверь вручную: codex login status.",

    job_finished_ago: (age) => `${age} назад, завершена`,
    job_running_for: (age) => `идёт ${age}`,
    trail_truncated: "  · […лента обрезана, полный журнал — codex_progress]",
    trail_header: "Ход работы GPT (сводки, не полные рассуждения):",
    answer_header: "Ответ GPT:",

    effort_hint: (bad) => `${bad}\nПолный список — инструмент codex_models.`,
    model_unverified: (model, available) =>
      `Модель "${model}" отсутствует в каталоге Codex — вызываю всё равно, решает сам Codex. ` +
      `В каталоге: ${available}\nЕсли имя ошибочно, вызов упадёт ошибкой API. Обновить список — инструмент codex_models.`,

    cancelled: (id) => `Вызов отменён, задача ${id} остановлена.`,
    cancelled_chat: (id, slug) => `Вызов отменён, задача ${id} остановлена. Тред "${slug}" не изменён.`,
    timed_out: (sec, id) => `GPT не уложился в ${sec}с — та же работа продолжается в фоне: ${id}`,
    follow_answer: "Смотри ход работы: codex_progress. Забрать ответ: codex_result.",
    follow_result: "Смотри ход работы: codex_progress. Забрать результат: codex_result.",

    need_message: "Нужно поле message.",
    need_task: "Нужно поле task.",
    bad_chat_name: (slug) => `Недопустимое имя чата: ${slug}. Разрешены латиница, цифры, точка, дефис.`,
    chat_timed_out: (sec, id, slug) =>
      `Модель не уложилась в ${sec}с — работа продолжается в фоне: ${id}\n` +
      `Ответ придёт в тред "${slug}" — забери его через codex_result, потом продолжай разговор.`,
    chat_thread_lost: (slug, threadId, error) =>
      `Тред "${slug}" (${threadId}) не удалось продолжить — Codex его не нашёл.\n` +
      `Сессия могла быть удалена или запись велась с другим CODEX_HOME.\n` +
      `Забудь разговор (codex_chats с forget: "${slug}") и начни заново.\n\n${error}`,
    chat_head: (slug, model, turn, noThread) =>
      `Чат "${slug}"${model ? ` · ${model}` : ""} · ход ${turn}` +
      (noThread ? "\n(тред не сохранён: Codex не сообщил id сессии — следующий ход начнёт разговор заново)" : ""),
    chat_forgotten: (slug) => `Разговор "${slug}" забыт. Следующее сообщение начнёт новый тред.`,
    chat_not_found: (slug) => `Разговор "${slug}" не найден.`,
    no_chats: "Разговоров с моделями Codex пока нет.",
    chat_line: (slug, model, effort, turns, age, noThread, cwd) =>
      `${slug}${model ? ` · ${model}` : ""}${effort ? ` · ${effort}` : ""} — ходов ${turns}, ` +
      `обновлён ${age} назад${noThread ? " (тред не сохранён)" : ""}\n    ${cwd}`,

    prefs_cleared: "Сброшено. Дальше действуют значения из настроек плагина.",
    prefs_current: (model, effort) =>
      `Для этого репозитория: модель ${model}, effort ${effort}.\n` +
      `Это значение проекта, а не конкретного окна Claude: надёжного идентификатора сессии у MCP-вызова нет.`,
    prefs_set: (model, effort, repo) =>
      `Дальше по умолчанию: модель ${model}, effort ${effort}.\nДействует для репозитория ${repo}, а не только для этого окна Claude.`,
    from_settings: "(из настроек плагина)",

    job_not_found: "Задача не найдена. Список — codex_status.",
    job_not_found_id: (id) => `Задача ${id} не найдена.`,
    no_jobs: "Фоновых задач Codex в этом репозитории нет.",
    no_events_yet: (id, status, age) =>
      `${id} [${status}] — событий пока нет (${age} с запуска).\n` +
      `Если Codex запущен без поддержки --json, лента недоступна; используй codex_result по завершении.`,
    progress_head: (id, status, age) => `${id} [${status}], идёт ${age}`,
    progress_finished: "\n\nРабота завершена — забери результат через codex_result.",
    still_running: (id, age) => `${id} ещё выполняется (${age}).`,
    trail_section: "--- ход работы ---",
    empty_output: "(вывод пуст)",
    empty_so_far: "(пока пусто)",

    diff_failed: (reason) => `Не удалось собрать изменения для ревью: ${reason}`,
    review_timed_out: (id) => `Не уложилось в 8 минут — работа продолжается в фоне: ${id}`,
    review_started: (adversarial, id) =>
      `Запущено ${adversarial ? "состязательное ревью" : "ревью"} в фоне: ${id}\n` +
      `Следить: codex_progress. Забрать результат: codex_result.`,
    delegated: (id) => `Задача делегирована GPT: ${id}\nGPT работает в рабочей директории и может менять файлы. Следить: codex_progress.`,
    cancelled_note: "отменена.",
    unknown_tool: (name) => `Неизвестный инструмент: ${name}`,
    age_seconds: (n) => `${n}с`,
    age_minutes: (n) => `${n}м`,
    age_hours: (n) => `${n}ч`,
  },
};

/** Ответы и отказы инструментов на текущем языке. */
export function uiText() {
  return { ...UI.en, ...(UI[lang()] || {}) };
}

// Ядро: сбор контекста ревью, менеджер задач, разбор отказов Codex.
const CORE = {
  en: {
    bad_job_id: (id) => `Invalid task identifier: ${id}`,
    job_path_escape: (id) => `Task path escaped its directory: ${id}`,
    job_not_found: (id) => `Task ${id} not found.`,
    job_not_found_plain: "Task not found.",
    already_status: (status) => `Already in status ${status}.`,
    job_still_running: "The task is still running.",

    git_not_started: (cmd, reason) => `git ${cmd} failed to start: ${reason}`,
    git_failed: (cmd, code, stderr) => `git ${cmd} exited with code ${code}: ${stderr}`,
    git_no_output: "no output",
    git_diff_failed: (reason) => `git diff did not run: ${reason}`,
    ref_not_commit: (ref) => `Reference ${ref} does not resolve to a commit in this repository.`,
    not_a_repo: "This is not a git repository — there is nothing to review.",
    clean_tree_no_base: "The working tree is clean and no default branch was found. Name the base explicitly.",
    no_merge_base: (base) =>
      `${base} and HEAD share no common ancestor, so there is nothing to compare against. Name a base that belongs to the same history.`,
    diff_secrets_hidden: (files) =>
      `[these files look like they carry credentials, so their contents are withheld — read them yourself if the review needs them]\n${files}`,
    names_more: (n) => `… and ${n} more files`,
    commits_more: "… earlier commits omitted",

    untracked_unreadable: (rel) => `${rel} — unreadable`,
    untracked_symlink: (rel, target) => `${rel} — symbolic link to ${target}`,
    untracked_directory: (rel) => `${rel} — directory`,
    untracked_not_regular: (rel) => `${rel} — not a regular file`,
    untracked_secret: (rel) => `${rel} — looks like a secret, contents withheld`,
    untracked_too_big: (rel, size, limit) => `${rel} — ${size} B, over the ${limit} B limit`,
    untracked_over_total: (rel) => `${rel} — did not fit the overall limit`,
    untracked_binary: (rel) => `${rel} — binary`,
    untracked_more: (n, limit) => `… and ${n} more files over the limit of ${limit}`,
    untracked_listed_only: "Listed by name only",

    no_changes: "(no changes)",
    empty_section: "(empty)",
    patch_too_big: (range, shortstat, fileCount, names) =>
      `The patch is too large to include in full, and truncating it midway is not an option — ` +
      `a truncated patch looks complete. Read the parts you need yourself, read-only: \`git diff ${range}\`.` +
      `\n\nSummary: ${shortstat}\nFiles changed: ${fileCount}\n\n${names}`,
    none: "none",

    sec_reviewing: "Under review",
    sec_branch_commits: "Branch commits",
    sec_committed: "Changes in commits",
    sec_not_committed: "Not committed yet",
    sec_new_files: "New files",
    no_commits: "(no commits)",
    clean_worktree: "(working tree is clean)",
    working_tree_only: "Uncommitted changes in the working tree.",
    branch_head: (branch, base, mergeBase) =>
      `Branch ${branch} against ${base} (merge base ${mergeBase}).\n` +
      `Two parts follow: what is committed on the branch and what is not committed yet. ` +
      `The first goes into the PR, the second does not.`,

    start_lock_busy: "Task startup is held by another call longer than usual. Retry in a few seconds.",
    limit_reached: (live, limit, list) =>
      `${live} tasks are already running against a limit of ${limit}. Wait for them or drop the extra ones with codex_cancel:\n${list}`,

    note_timeout: "The task was stopped on timeout.",
    note_cancelled: "The task was cancelled.",
    note_spawn_failed: "Codex did not start: check the installation (npm install -g @openai/codex).",
    note_vanished: "The process disappeared without writing an exit code. The result is not trustworthy.",
    worker_spawn_failed: (reason) => `failed to start the worker: ${reason}`,

    codex_exit: (status, code) => `Codex ended with status ${status}${code === null ? "" : ` (code ${code})`}.`,
    trail_label: "Progress:",
    partial_output: (out) => `Partial output (do not treat as the result):\n${out}`,

    effort_unsupported: (model, effort, supported) =>
      `Model ${model} does not accept effort level "${effort}".` +
      (supported ? ` Supported: ${supported}.` : "") +
      ` Set another level via the effort argument or the plugin's default_effort setting.`,
    sandbox_windows: (bin) =>
      `The Windows sandbox did not start: Codex could not find its helper binary${bin}. ` +
      `This is not an MCP server failure and not a user cancellation — the bridge is fine.\n` +
      `The usual cause is a Codex installation assembled from different versions (CLI of one version, ` +
      `helpers in ~/.codex/.sandbox-bin of another).\n` +
      `What to do: reinstall Codex entirely (npm install -g @openai/codex) — that fixes the cause; ` +
      `or, as a temporary workaround, turn on the plugin's bypass_sandbox setting, ` +
      `but then Codex runs commands without isolation. Diagnostics: /tandem:setup`,
    mcp_cancelled:
      "Codex reported a cancelled tool call. If you cancelled nothing, the most likely cause is a Codex sandbox failure, " +
      "which surfaces exactly like this. Check with: /tandem:setup",
    not_authorized: "Codex is not authorised, or the session expired. Run in a terminal: codex login",
    quota: "The ChatGPT subscription limit is reached. Wait for the quota to reset or switch to a cheaper model.",
    unknown_flag: (flag) =>
      `This Codex build does not know the ${flag} flag. Update the plugin: the codex exec flag set ` +
      `changes between versions, and the bridge detects it from codex exec --help. ` +
      `If the error survives the update, clear the detection cache: delete exec-caps.json ` +
      `in the plugin data directory.`,
  },

  ru: {
    bad_job_id: (id) => `Недопустимый идентификатор задачи: ${id}`,
    job_path_escape: (id) => `Путь задачи вышел за пределы каталога: ${id}`,
    job_not_found: (id) => `Задача ${id} не найдена.`,
    job_not_found_plain: "Задача не найдена.",
    already_status: (status) => `Уже в статусе ${status}.`,
    job_still_running: "Задача ещё выполняется.",

    git_not_started: (cmd, reason) => `git ${cmd} не запустился: ${reason}`,
    git_failed: (cmd, code, stderr) => `git ${cmd} завершился с кодом ${code}: ${stderr}`,
    git_no_output: "без вывода",
    git_diff_failed: (reason) => `git diff не выполнен: ${reason}`,
    ref_not_commit: (ref) => `Ссылка ${ref} не разрешается в коммит этого репозитория.`,
    not_a_repo: "Это не git-репозиторий — ревьюить нечего.",
    clean_tree_no_base: "Рабочее дерево чистое, а ветку по умолчанию найти не удалось. Укажи base явно.",
    no_merge_base: (base) =>
      `У ${base} и HEAD нет общего предка, сравнивать не с чем. Укажи базу из той же истории.`,
    diff_secrets_hidden: (files) =>
      `[эти файлы похожи на хранилища учётных данных, поэтому их содержимое не показано — прочитай сам, если оно нужно для ревью]\n${files}`,
    names_more: (n) => `… и ещё ${n} файлов`,
    commits_more: "… более ранние коммиты опущены",

    untracked_unreadable: (rel) => `${rel} — нечитаем`,
    untracked_symlink: (rel, target) => `${rel} — символическая ссылка на ${target}`,
    untracked_directory: (rel) => `${rel} — каталог`,
    untracked_not_regular: (rel) => `${rel} — не обычный файл`,
    untracked_secret: (rel) => `${rel} — похоже на секрет, содержимое не показано`,
    untracked_too_big: (rel, size, limit) => `${rel} — ${size} Б, больше предела ${limit} Б`,
    untracked_over_total: (rel) => `${rel} — не поместился в общий предел`,
    untracked_binary: (rel) => `${rel} — двоичный`,
    untracked_more: (n, limit) => `… и ещё ${n} файлов сверх предела ${limit}`,
    untracked_listed_only: "Показаны только именами",

    no_changes: "(изменений нет)",
    empty_section: "(пусто)",
    patch_too_big: (range, shortstat, fileCount, names) =>
      `Патч слишком велик, чтобы вложить его целиком, и обрезать его посередине нельзя — ` +
      `обрезанный патч выглядит полным. Прочитай нужные места сам, только на чтение: \`git diff ${range}\`.` +
      `\n\nСводка: ${shortstat}\nФайлов изменено: ${fileCount}\n\n${names}`,
    none: "нет",

    sec_reviewing: "Ревьюется",
    sec_branch_commits: "Коммиты ветки",
    sec_committed: "Изменения в коммитах",
    sec_not_committed: "Ещё не закоммичено",
    sec_new_files: "Новые файлы",
    no_commits: "(коммитов нет)",
    clean_worktree: "(рабочее дерево чистое)",
    working_tree_only: "Незакоммиченные изменения рабочего дерева.",
    branch_head: (branch, base, mergeBase) =>
      `Ветка ${branch} относительно ${base} (общий предок ${mergeBase}).\n` +
      `Ниже две части: закоммиченное в ветке и то, что ещё не закоммичено. Первое уйдёт в PR, второе — нет.`,

    start_lock_busy: "Запуск задачи занят другим вызовом дольше обычного. Повтори через несколько секунд.",
    limit_reached: (live, limit, list) =>
      `Уже выполняется ${live} задач при пределе ${limit}. Дождись их или сними лишние через codex_cancel:\n${list}`,

    note_timeout: "Задача остановлена по таймауту.",
    note_cancelled: "Задача отменена.",
    note_spawn_failed: "Codex не запустился: проверь установку (npm install -g @openai/codex).",
    note_vanished: "Процесс исчез, не записав код возврата. Результат недостоверен.",
    worker_spawn_failed: (reason) => `не удалось запустить воркер: ${reason}`,

    codex_exit: (status, code) => `Codex завершился со статусом ${status}${code === null ? "" : ` (код ${code})`}.`,
    trail_label: "Ход работы:",
    partial_output: (out) => `Частичный вывод (не считать результатом):\n${out}`,

    effort_unsupported: (model, effort, supported) =>
      `Модель ${model} не принимает уровень усилий "${effort}".` +
      (supported ? ` Поддерживаются: ${supported}.` : "") +
      ` Задай другой уровень аргументом effort или в настройке default_effort плагина.`,
    sandbox_windows: (bin) =>
      `Не запустилась песочница Windows: Codex не нашёл вспомогательный бинарь${bin}` +
      `. Это не отказ MCP-сервера и не отмена пользователем — мост исправен.\n` +
      `Обычная причина: установка Codex собрана из разных версий (CLI одной версии, ` +
      `хелперы в ~/.codex/.sandbox-bin другой).\n` +
      `Что делать: переустановить Codex целиком (npm install -g @openai/codex) — это решает причину; ` +
      `либо, как временный обход, включить настройку плагина bypass_sandbox, ` +
      `но тогда Codex будет выполнять команды без изоляции. Диагностика: /tandem:setup`,
    mcp_cancelled:
      "Codex сообщил об отмене вызова инструмента. Если вы ничего не отменяли, " +
      "наиболее вероятная причина — сбой песочницы Codex, который выходит наружу именно так. " +
      "Проверьте: /tandem:setup",
    not_authorized: "Codex не авторизован или сессия истекла. Выполни в терминале: codex login",
    quota: "Достигнут лимит подписки ChatGPT. Подожди сброса квоты или смени модель на более дешёвую.",
    unknown_flag: (flag) =>
      `Эта сборка Codex не знает флаг ${flag}. Обнови плагин: набор флагов codex exec меняется ` +
      `между версиями, и мост определяет его по codex exec --help. ` +
      `Если после обновления ошибка осталась — сбрось кэш определения: удали exec-caps.json ` +
      `в каталоге данных плагина.`,
  },
};

/** Сообщения ядра на текущем языке. */
export function coreText() {
  return { ...CORE.en, ...(CORE[lang()] || {}) };
}

/**
 * Промпт для вызываемой модели. Английский — запасной вариант для любого
 * ключа: отсутствующий перевод не должен ронять запуск задачи.
 */
export function prompt(key, ...args) {
  const table = PROMPTS[lang()] || PROMPTS.en;
  const fn = table[key] || PROMPTS.en[key];
  if (typeof fn !== "function") throw new Error(`Неизвестный промпт: ${key}`);
  return fn(...args);
}
