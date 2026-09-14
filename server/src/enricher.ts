import db from "./db.js";

// Зависимости задач: какие карточки ждут завершения соседних.
//
// 14.09.2026 отсюда убрана «доска объявлений» — старая схема, где свободная
// задача помечалась ярлыком профиля, висела в общем пуле, и агент сам
// приходил и забирал подходящую. Подбор там шёл по совпадению ключевых
// слов в названии; исполнителями были прежние личности (Клод-бот, Гермес,
// Дипсик), а не восемь ролей.
//
// Причина удаления (владелец 14.09.2026): исполнитель теперь подбирается
// по смыслу задачи и назначается сразу при создании — висеть в пуле стало
// нечему, и доска дублировала назначение, отвечая на тот же вопрос хуже.
// На проверке смысловой подбор дал 6 попаданий из 6 против 3 у словарного.
//
// Зависимости к той схеме отношения не имеют и остаются: это про порядок
// работ, а не про то, кто их берёт.

export function taskDependencies(taskId: string): Array<{ id: string; title: string; status: string }> {
  return db
    .prepare(
      `SELECT t.id, t.title, t.status
         FROM task_dependencies d
         JOIN tasks t ON t.id = d.depends_on_task_id
        WHERE d.task_id = ? ORDER BY d.created_at, t.id`,
    )
    .all(taskId) as Array<{ id: string; title: string; status: string }>;
}

export function unmetDependencyIds(taskId: string): string[] {
  return (db
    .prepare(
      `SELECT t.id FROM task_dependencies d
         JOIN tasks t ON t.id = d.depends_on_task_id
        WHERE d.task_id = ? AND t.status <> 'completed'`,
    )
    .all(taskId) as Array<{ id: string }>).map((row) => row.id);
}

