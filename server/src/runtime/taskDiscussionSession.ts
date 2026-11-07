import {registerProviderSession, observeProviderRetries} from "./providerDiagnostics.js";
// Ход обсуждения карточки (карточка 252c400e, этапы 3–4 плана).
//
// Ключевые свойства (контракт архитектора f3ada2e0, §5):
//   • отдельная сессия — рабочий файл исполнителя НЕ открывается и не
//     переключается; своя аренга по discussion_id;
//   • read-only: каталог инструментов строится в режиме
//     «task_discussion», где gateway технически отвергает любую запись
//     (server/src/runtime/universalTaskflow.ts, operationRestriction);
//   • промежуточные реплики в работу не уходят: этот модуль НЕ вызывает
//     deliverTopicToWork/deliverChatToWork;
//   • ответ пишется в ленту обсуждения, а не в рабочую ленту.
//
// Модуль намеренно узкий: он даёт серверу один вход (ответ на реплику
// владельца) и один выход (текст ответа в комнате обсуждения).

import crypto from "node:crypto";
import { createAgentSession, createCodingTools, createReadOnlyTools, SettingsManager } from "@earendil-works/pi-coding-agent";
import { roleInstructionText } from "./roleHome.js";
import { connectRoleMcp } from "./graftMcp.js";
import { buildRoleToolCatalog, installNativeToolCore, installNativeToolSchemas } from "./roleToolCatalog.js";
import { getModelRuntime, resolveThinkingLevel } from "./PiRuntimeAdapter.js";
import { createTaskResourceLoader } from "./instructionResources.js";
import { acquireDiscussionSession, openDiscussionSession } from "./slotSession.js";
import { loadRoleRouting, roleUserId } from "../roleRouting.js";
import { findRuntimeModel } from "../lib/attemptModel.js";
import db from "../db.js";
import {
  TASK_DISCUSSION_MODE,
  acceptsReplies,
  insertDiscussionMessage,
  readDiscussion,
  trackDiscussionAnswer,
} from "./taskDiscussion.js";

export interface DiscussionTurnInput {
  discussionId: string;
  role: string;
  /** Реплика владельца. */
  prompt: string;
  cwd: string;
  /** Таймаут хода обсуждения, мс. */
  timeoutMs?: number;
}

export interface DiscussionTurnResult {
  ok: boolean;
  text: string;
  sessionId: string | null;
  /** Обсуждение уже закрыто — новая реплика не принимается. */
  rejected?: "closed";
  error?: string;
}

/** Текст ответа роли в комнате обсуждения. */
export function runDiscussionTurn(input: DiscussionTurnInput): Promise<DiscussionTurnResult> {
  const discussion = readDiscussion(input.discussionId);
  if (!discussion) return Promise.resolve({ok: false, text: "", sessionId: null, error: "Обсуждение не найдено"});
  if (!acceptsReplies(input.discussionId)) return Promise.resolve({ok: false, text: "", sessionId: null, rejected: "closed"});
  const answer = runDiscussionTurnInternal(input);
  // Includes lease wait, preparation, prompting and persistence of the reply.
  trackDiscussionAnswer(input.discussionId, answer);
  return answer;
}
async function runDiscussionTurnInternal(input: DiscussionTurnInput): Promise<DiscussionTurnResult> {
  const discussion = readDiscussion(input.discussionId);
  if (!discussion) return { ok: false, text: "", sessionId: null, error: "Обсуждение не найдено" };
  if (!acceptsReplies(input.discussionId))
    return { ok: false, text: "", sessionId: null, rejected: "closed" };

  const controller = new AbortController();
  const release = await acquireDiscussionSession(input.discussionId, controller.signal);
  let session: any;
  let resources: Awaited<ReturnType<typeof createTaskResourceLoader>> | undefined;
  let infra: { tools: any[]; close: () => Promise<any> } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const runId = "disc_" + crypto.randomUUID();
  try {
    const modelId = loadRoleRouting().models[input.role];
    const runtime: any = await getModelRuntime();
    const model = await findRuntimeModel(runtime, modelId);
    if (!model) return { ok: false, text: "", sessionId: null, error: `модель «${modelId}» недоступна` };

    const manager = openDiscussionSession(
      discussion.task_id,
      input.role,
      discussion.subtask_id ?? "discussion",
      discussion.discussion_id,
      input.cwd,
    );
    const cwd = manager.getCwd();
    const policy = [
      "Режим обсуждения работающей карточки.",
      "Отвечай по существу, коротко. Обсуждение — только чтение: не меняй файлы,",
      "задачи, этапы, статусы, план и настройки, не запускай команды записи.",
      "Работа исполнителя продолжается отдельно — твои ответы в неё не попадают.",
      "В конце ответа, если договорённость требует подтверждения владельцем,",
      "напиши ровно: «требует подтверждения владельцем».",
    ].join("\n");
    resources = await createTaskResourceLoader(input.role, cwd, [
      roleInstructionText(input.role, { withAgents: false }),
      policy,
    ].join("\n\n"));
    // Тот же полный набор, что в работе (владелец 07.11.2026).
    const builtin = [...new Map([...createCodingTools(cwd), ...createReadOnlyTools(cwd)].map((tool) => [tool.name, tool])).values()];
    infra = await connectRoleMcp(input.role, cwd).catch(() => ({ tools: [], close: async () => {} }));
    let errorLoop = false;
    const catalog = buildRoleToolCatalog(
      {
        role: input.role,
        model: (model as any).id ?? modelId,
        taskId: discussion.task_id,
        subtaskId: discussion.subtask_id ?? undefined,
        chatId: discussion.chat_id,
        mode: TASK_DISCUSSION_MODE,
        onErrorLoop: () => {
          errorLoop = true;
          // Do not await abort from the running tool: it waits for tool completion.
          void session?.abort();
        },
        runId,
      },
      infra.tools,
    );
    registerProviderSession(manager.getSessionId(), {role:input.role, task_id:discussion.task_id, discussion_id:input.discussionId, run_id:runId, origin:"task_discussion"});
    ({ session } = await createAgentSession({
      cwd,
      model,
      thinkingLevel: resolveThinkingLevel(model as any, input.role) ?? undefined,
      modelRuntime: runtime,
      resourceLoader: resources,
      tools: [...builtin.map((tool) => tool.name), ...catalog.registeredNames],
      customTools: [...builtin, ...catalog.customTools],
      sessionManager: manager,
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: true }, retry: { enabled: true, maxRetries: 2 } }),
    } as any));

    observeProviderRetries(session, manager.getSessionId());
    installNativeToolCore(session, catalog, builtin.map(tool => tool.name));
    installNativeToolSchemas(session, catalog);
    let timedOut = false;
    let lastAssistant: any;
    session.subscribe((event: any) => {
      if (event.type === "agent_end" && Array.isArray(event.messages))
        lastAssistant = [...event.messages].reverse().find((m: any) => m.role === "assistant");
    });
    timer = setTimeout(() => {
      timedOut = true;
      void session.abort();
    }, input.timeoutMs ?? 30 * 60 * 1000);
    timer.unref?.();

    const answerPromise = session.prompt(`${policy}\n\nВопрос владельца:\n${input.prompt}`);
    // Закрытие обсуждения дождётся текущего ответа: отвечающий ход виден.
    await answerPromise;
    if (errorLoop) return {ok: false, text: "", sessionId: manager.getSessionId(), error: "Обсуждение остановлено: повторяются неверные вызовы инструмента"};
    if (timedOut) return { ok: false, text: "", sessionId: manager.getSessionId(), error: "Время обсуждения истекло" };
    const answer = lastAssistant ?? [...session.state.messages].reverse().find((m: any) => m.role === "assistant");
    if (answer?.stopReason === "error")
      return { ok: false, text: "", sessionId: manager.getSessionId(), error: answer.errorMessage || "Ответ не получен" };
    const text = (answer?.content ?? [])
      .filter((part: any) => part.type === "text")
      .map((part: any) => part.text)
      .join("\n")
      .trim();
    if (text) {
      insertDiscussionMessage({ chatId: discussion.chat_id, fromUserId: roleUserId(input.role), text });
    }
    return { ok: true, text, sessionId: manager.getSessionId() };
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code === "CHAT_RUN_CANCELLED")
      return { ok: false, text: "", sessionId: null, error: "Обсуждение остановлено" };
    return { ok: false, text: "", sessionId: null, error: error instanceof Error ? error.message : String(error) };
  } finally {
    if (timer) clearTimeout(timer);
    session?.dispose();
    resources?.disposeResources();
    await infra?.close().catch(() => {});
    release();
  }
}

/** Снимок состояния обсуждения для владельца. */
export function discussionSnapshot(discussionId: string) {
  const discussion = readDiscussion(discussionId);
  if (!discussion) return null;
  const messages = db
    .prepare("SELECT count(*) n FROM chat_messages WHERE chat_id=?")
    .get(discussion.chat_id) as { n: number };
  return {
    discussion_id: discussion.discussion_id,
    chat_id: discussion.chat_id,
    task_id: discussion.task_id,
    subtask_id: discussion.subtask_id,
    state: discussion.state,
    delivery_state: discussion.delivery_state,
    handoff_id: discussion.handoff_id,
    summary_id: discussion.summary_id,
    messages: messages.n,
    accepted_at: discussion.accepted_at,
  };
}
