// Общий хелпер для тестов, которые полагаются на единственного владельца в
// системе.
//
// Миграция 039_seed_owner (от 18.09.2026) сидит учётку 'u1' с role='owner'
// на каждой свежей БД. До этой миграции тесты, регистрирующие владельца
// руками и переводящие его через `UPDATE users SET role='owner'`, работали:
// `ownerId()` в routes/chat.ts (и других) берёт самого раннего владельца
// из БД, и это был именно тестовый пользователь. После миграции 'u1'
// всегда оказывается раньше тестового владельца, и `ownerId()` упорно
// возвращает 'u1' — а тесты продолжают работать с токеном своей учётки.
//
// В результате ломается ровно то, что зависит от `fromUserId === owner` в
// routeMessage / диспетчере / настройках приёма задач: сообщение уходит не
// в тот канал, владелец получает 403 вместо 200.
//
// Этот хелпер в beforeAll теста понижает 'u1' до 'agent', чтобы владельцем
// был тот, кого заводит сам тест. Локально — чтобы 50+ других тестов, не
// полагающихся на единственного владельца, не трогать. Если тест хочет
// использовать самого 'u1' (например, для проверки seed-данных) — он
// просто не вызывает этот хелпер.
//
// Тесты, которые ломались именно из-за u1 и теперь чинятся через этот
// хелпер: chat-channels, ownerDictation, task-intake. readyDispatchBridge
// использует тот же приём плюс сидит role_* пользователей отдельным шагом.
//
// Второй помощник — seedRoleAccounts(). dispatch.ts при отдаче задачи
// ставит assignee_id = ROLE_USER_IDS[chosen] (= "role_architect" и т.п.),
// и notification/inbox идут на того же role-пользователя. В живой БД эти
// учётки заведены руками владельцем или через POST /api/agents; миграций,
// которые их сеят, в текущем наборе нет. Без них FOREIGN KEY в диспетчере
// валится. Тест, вызывающий диспетчер через /api/tasks/:id/dispatch или
// через автоматический режим надиктовки, должен посеять role-учётки
// заранее — иначе задача «отдаётся» 500-кой, а assignee_id остаётся null,
// и тесты на PI_AGENT_ID падают по неинформативной причине.
import type { Database } from "better-sqlite3";

export function demoteSeededOwner(db: Database): void {
  db.prepare("UPDATE users SET role = 'agent' WHERE id = 'u1'").run();
}

const ROLE_ACCOUNTS: Array<{ id: string; name: string; email: string; role: string }> = [
  { id: "role_researcher", name: "Researcher", email: "researcher@taskflow.local", role: "researcher" },
  { id: "role_analyst", name: "Analyst", email: "analyst@taskflow.local", role: "analyst" },
  { id: "role_critic_verifier", name: "Critic Verifier", email: "critic@taskflow.local", role: "critic_verifier" },
  { id: "role_architect", name: "Architect", email: "architect@taskflow.local", role: "architect" },
  { id: "role_builder", name: "Builder", email: "builder@taskflow.local", role: "builder" },
  { id: "role_qa", name: "QA", email: "qa@taskflow.local", role: "qa" },
  { id: "role_designer", name: "Designer", email: "designer@taskflow.local", role: "designer" },
];

export function seedRoleAccounts(db: Database): void {
  const ins = db.prepare(
    `INSERT OR IGNORE INTO users
       (id, name, email, password_hash, role, role_key, type, avatar_color, initials, status, is_system_bot)
     VALUES (?, ?, ?, '', 'agent', ?, 'ai', '#8E8E93', ?, 'offline', 1)`,
  );
  const tx = db.transaction((rows: typeof ROLE_ACCOUNTS) => {
    for (const r of rows) ins.run(r.id, r.name, r.email, r.role, r.name[0]);
  });
  tx(ROLE_ACCOUNTS);
}
