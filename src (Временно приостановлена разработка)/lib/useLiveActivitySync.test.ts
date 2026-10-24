// Отбор задач для Live Activity: какие три из всех работающих попадут в
// островок и на экран блокировки. Всё остальное в островке проверяется только
// на телефоне, а это — чистая логика, и ошибиться в ней проще всего.

import { describe, expect, it } from "vitest";
import type { ApiTask } from "../api/types";
import { pickTargets } from "./useLiveActivitySync";

function task(
  id: string,
  opts: Partial<ApiTask> & { heartbeat?: string } = {},
): ApiTask {
  const { heartbeat, ...rest } = opts;
  return {
    id,
    title: id,
    status: "active",
    agent_state: "in_progress",
    agent_heartbeat_at: heartbeat ?? "2026-08-24 10:00:00",
    updated_at: "2026-08-24 10:00:00",
    subtasks: [],
    ...rest,
  } as unknown as ApiTask;
}

const ids = (list: ApiTask[]) => list.map((t) => t.id);

describe("pickTargets — какие задачи попадают в островок", () => {
  it("берёт не больше трёх и самые свежие по сигналу агента", () => {
    const tasks = [
      task("a", { heartbeat: "2026-08-24 10:00:01" }),
      task("b", { heartbeat: "2026-08-24 10:00:04" }),
      task("c", { heartbeat: "2026-08-24 10:00:03" }),
      task("d", { heartbeat: "2026-08-24 10:00:02" }),
    ];
    expect(ids(pickTargets(tasks, null, []))).toEqual(["b", "c", "d"]);
  });

  it("не трогает задачи, по которым работа не идёт", () => {
    const tasks = [
      task("работает"),
      task("на проверке", { agent_state: "review" }),
      task("закрыта", { status: "completed" }),
      task("без агента", { agent_state: null as any }),
    ];
    expect(ids(pickTargets(tasks, null, []))).toEqual(["работает"]);
  });

  it("держит уже показанную задачу на месте, пока по ней идёт работа", () => {
    // Свежесть у «старой» хуже всех, но она уже висит на экране: выкидывать её
    // ради чужого сигнала нельзя — карточки начнут мигать по кругу.
    const tasks = [
      task("старая", { heartbeat: "2026-08-24 09:00:00" }),
      task("новая1", { heartbeat: "2026-08-24 10:00:03" }),
      task("новая2", { heartbeat: "2026-08-24 10:00:02" }),
      task("новая3", { heartbeat: "2026-08-24 10:00:01" }),
    ];
    expect(ids(pickTargets(tasks, null, ["старая"]))).toEqual([
      "старая",
      "новая1",
      "новая2",
    ]);
  });

  it("вручную выведенная задача стоит первой и остаётся, даже когда работа по ней не идёт", () => {
    const tasks = [
      task("руками", { agent_state: null as any }),
      task("работа1", { heartbeat: "2026-08-24 10:00:03" }),
      task("работа2", { heartbeat: "2026-08-24 10:00:02" }),
      task("работа3", { heartbeat: "2026-08-24 10:00:01" }),
    ];
    expect(ids(pickTargets(tasks, "руками", []))).toEqual([
      "руками",
      "работа1",
      "работа2",
    ]);
  });

  it("закрытую задачу не показывает, даже если её вывели руками", () => {
    const tasks = [
      task("руками", { status: "completed" }),
      task("работа"),
    ];
    expect(ids(pickTargets(tasks, "руками", []))).toEqual(["работа"]);
  });

  it("не повторяет одну задачу дважды", () => {
    const tasks = [task("одна"), task("вторая")];
    expect(ids(pickTargets(tasks, "одна", ["одна"]))).toEqual([
      "одна",
      "вторая",
    ]);
  });
});
