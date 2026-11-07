import { Type } from "typebox";
import db from "../db.js";
import { isOrchestrator } from "../access.js";
import { roleUserId } from "../roleRouting.js";
import { asRole } from "./inProcessRun.js";

type Factory = (name: string, description: string, parameters: any, run: (p: any) => Promise<any>) => any;

// Чтение плана, зависимостей, дочерних карточек и состава команды — всем
// ролям (владелец 14.10.2026): чтобы видеть, кто из коллег что делает и в
// какой последовательности, и кооперироваться. Только чтение; у Оркестратора
// те же имена с правом правки — из orchestratorTools, здесь ему ничего.
// Роли и так звали plan_read, dependencies и children — по журналу ходов это
// были самые частые «нет такого инструмента». Состав команды закрывает тот же
// вопрос «кто есть и кто на связи», но каталогом ролей (/api/roles), а не
// списком запущенных агентов (/api/agents) — тот остаётся только в чате.
export function teamReadTools(role: string, T: Factory): any[] {
  if (isOrchestrator(roleUserId(role))) return [];
  const task = Type.Object({ task_id: Type.String({ minLength: 1 }) });
  const get = (url: string) => asRole(role, "GET", url);
  return [
    T("taskflow_team_read", "Прочитать состав команды: роли, чем каждая занимается, доступность.", Type.Object({}), () => get("/api/roles")),
    T("taskflow_plan_read", "Прочитать план задачи: этапы, кто за какой отвечает, порядок и состояние. Только чтение.", task,
      (p) => get("/api/tasks/" + encodeURIComponent(p.task_id) + "/collaboration-plans")),
    T("taskflow_dependencies", "Прочитать зависимости карточки: от каких задач она зависит. Только чтение.", task,
      (p) => get("/api/tasks/" + encodeURIComponent(p.task_id) + "/dependencies")),
    T("taskflow_children", "Прочитать прямые дочерние карточки с их состоянием и исполнителями. Только чтение.", task, async (p) => {
      await get("/api/tasks/" + encodeURIComponent(p.task_id));
      const rows = db.prepare("SELECT id FROM tasks WHERE parent_id=? ORDER BY created_at,id").all(p.task_id) as { id: string }[];
      return Promise.all(rows.map((r) => get("/api/tasks/" + encodeURIComponent(r.id))));
    }),
  ];
}
