import { startObservation, finishObservation } from "../lib/contextObservability.js";
import { spawn } from "node:child_process";
import path from "node:path";
import { getSetting } from "../lib/serverSettings.js";

export type LaunchContextInput = {
  task: Record<string, unknown>;
  actor: { id: string; name: string };
  dependency_context?: Record<string, unknown>;
  collaboration_context?: Record<string, unknown>;
  /** «Что уже было по этой карточке» — собранная сервером сводка прошлых ходов. */
  task_history?: Record<string, unknown>;
};

export type LaunchContext = {
  prompt: string;
  summary: string;
  knowledgeStatus: string;
  dependencyStatus: string;
};

export type LaunchContextRunner = (input: LaunchContextInput) => Promise<string>;

async function runPythonContext(input: LaunchContextInput): Promise<string> {
  const bridgePath = path.join(process.cwd(), "scripts", "task_context_bridge.py");
  return new Promise((resolve, reject) => {
    const process = spawn("python3", [bridgePath], { stdio: ["pipe", "pipe", "pipe"] });
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    const timeout = setTimeout(() => {
      process.kill();
      reject(new Error("сборка TaskContext v1 превысила заданный таймаут"));
    }, getSetting("task_context_timeout_ms"));
    process.stdout!.on("data", (chunk: Buffer) => output.push(chunk));
    process.stderr!.on("data", (chunk: Buffer) => errors.push(chunk));
    process.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    process.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve(Buffer.concat(output).toString("utf8"));
      else reject(new Error(Buffer.concat(errors).toString("utf8").trim() || `bridge завершился с кодом ${code}`));
    });
    process.stdin!.end(JSON.stringify(input));
  });
}

export async function buildInProcessTaskContext(
  input: LaunchContextInput,
  runner: LaunchContextRunner = runPythonContext,
): Promise<LaunchContext> {
  const observationContext={taskId:String(input.task.id??""),role:input.actor.id.replace(/^role_/,""),subtaskId:typeof input.collaboration_context?.subtask_id==="string"?input.collaboration_context.subtask_id:undefined};
  const observationId=startObservation("enricher","taskContext",observationContext);
  let payload: unknown;
  // Один автоповтор при таймауте или сбое (карточка 71651ad0, Г1: первый
  // запуск падает на «TaskContext >15 с»). Повторный сбой уже не
  // чинится — это уже не флак, а реальная проблема сборки контекста.
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      payload = JSON.parse(await runner(input));
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      if (attempt === 1) {
        finishObservation(observationId,{status:"error",reason:"context_build_failed"});
        throw new Error(`не удалось собрать TaskContext v1 после автоповтора: ${String(error)}`);
      }
    }
  }
  if (!payload || typeof payload !== "object") {
    finishObservation(observationId,{status:"error",reason:"invalid_response"});
    throw new Error(`не удалось собрать TaskContext v1: ${String(lastError)}`);
  }
  const value = payload as Record<string, unknown>;
  if (typeof value.prompt !== "string" || typeof value.summary !== "string") {
    finishObservation(observationId,{status:"error",reason:"invalid_response"});
    throw new Error("не удалось собрать TaskContext v1: bridge вернул неполный пакет");
  }
  finishObservation(observationId,{status:"ok",inputCount:value.prompt.length,outputCount:value.prompt.length,details:["Собран стартовый контекст; объём в символах"]});
  if(Array.isArray(value.observations))for(const item of value.observations){
    if(!item||typeof item!=="object")continue;const o=item as any;
    if(!["kb","repository","dependencies","collaboration","history"].includes(o.scenario))continue;
    finishObservation(startObservation("enricher",o.scenario,observationContext),{...o,status:o.status==="unavailable"?"error":o.status==="empty"?"skipped":o.status,reason:o.reason??(o.status==="unavailable"?"source_unavailable":o.status==="empty"?"empty":undefined)});
  }
  return {
    prompt: value.prompt,
    summary: value.summary,
    knowledgeStatus: typeof value.knowledge_status === "string" ? value.knowledge_status : "unknown",
    dependencyStatus: typeof value.dependency_status === "string" ? value.dependency_status : "unknown",
  };
}
