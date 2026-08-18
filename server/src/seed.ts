import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import db from "./db.js";

const uid = () => crypto.randomUUID();

export function registerSeedRoutes(app: FastifyInstance) {
  // One-time seed endpoint. Dev/test only: on a fresh DB there is no user
  // yet to authenticate as, so gating this behind auth would make it
  // uncallable at the one moment it's needed (bootstrap). NODE_ENV is the
  // real guard — this must never be reachable in production.
  app.post("/api/seed", async (_req, reply) => {
    if (process.env.NODE_ENV === "production") {
      return reply.code(404).send({ error: "Not found" });
    }

    // Check if already seeded
    const count = db.prepare("SELECT COUNT(*) as c FROM users").get() as any;
    if (count.c > 0) return { ok: true, message: "Already seeded" };

    const hash = bcrypt.hashSync("test123", 10);

    // Users
    const users = [
      {
        id: "u1",
        name: "Максим",
        email: "maksim@test.com",
        role: "owner",
        type: "human",
        color: "#35B8A3",
        initials: "М",
        isSystemBot: false,
      },
      {
        id: "u2",
        name: "Claude_Bot",
        email: "claude@taskflow.local",
        role: "agent",
        type: "ai",
        color: "#A78BFA",
        initials: "C",
        isSystemBot: true,
      },
      {
        id: "u3",
        name: "Hermes",
        email: "hermes@taskflow.local",
        role: "agent",
        type: "ai",
        color: "#FF9A14",
        initials: "H",
        isSystemBot: true,
      },
    ];
    const insUser = db.prepare(
      "INSERT INTO users (id,name,email,password_hash,role,type,avatar_color,initials,status,is_system_bot) VALUES (?,?,?,?,?,?,?,?,?,?)",
    );
    for (const u of users)
      insUser.run(
        u.id,
        u.name,
        u.email,
        hash,
        u.role,
        u.type,
        u.color,
        u.initials,
        "offline",
        u.isSystemBot ? 1 : 0,
      );

    // Projects
    const projects = [
      { id: "p1", name: "Входящие", color: "#4A9FD8" },
      { id: "p2", name: "Клод и Максим", color: "#A78BFA" },
      { id: "p3", name: "Цикл продаж", color: "#E44332" },
      { id: "p4", name: "Настройка проектов", color: "#FF9A14" },
      { id: "p5", name: "Ипотека", color: "#FF7A8A" },
      { id: "p6", name: "лягушка", color: "#8FBF9F" },
    ];
    const insProj = db.prepare(
      "INSERT INTO projects (id,name,color,owner_id) VALUES (?,?,?,?)",
    );
    for (const p of projects) insProj.run(p.id, p.name, p.color, "u1");

    // Labels
    const labels = [
      { id: "l1", name: "Ипотека", color: "#FF7A8A" },
      { id: "l2", name: "база-знаний", color: "#FF7A8A" },
      { id: "l3", name: "Клод и Максим", color: "#A78BFA" },
    ];
    const insLabel = db.prepare(
      "INSERT INTO labels (id,name,color,owner_id) VALUES (?,?,?,?)",
    );
    for (const l of labels) insLabel.run(l.id, l.name, l.color, "u1");

    // Tasks
    const tasks = [
      {
        id: "t1",
        title: "Оплатить коммуналку — август 2026",
        desc: "Квитанция на 8 432₽. Оплата до 25-го числа.",
        due: "2026-08-25",
        proj: "p1",
        pri: 1,
        ass: null,
        labels: [],
      },
      {
        id: "t2",
        title: "Судебное заседание",
        desc: "Кабинет 232. Слушание по моему делу, озвучить свои возражения по иску.",
        due: "2026-08-11",
        proj: "p1",
        pri: 1,
        ass: "u2",
        labels: ["l1"],
      },
      {
        id: "t3",
        title: "Выпустить ЭЦП",
        desc: "Через «Правовед» или Госуслуги. Стоимость 1 500–2 500₽.",
        due: "2026-08-15",
        proj: "p1",
        pri: 2,
        ass: null,
        labels: [],
      },
      {
        id: "t4",
        title: "Сдать показания счётчиков",
        desc: "ГВС и ХВС. Не позже 28 августа.",
        due: "2026-08-28",
        proj: "p1",
        pri: 1,
        ass: null,
        labels: [],
      },
      {
        id: "t5",
        title: "Убрать квартиру",
        desc: "Генеральная уборка кухни и ванной.",
        due: "2026-08-17",
        proj: "p1",
        pri: 1,
        ass: null,
        labels: [],
      },
      {
        id: "t6",
        title: "Изучить Госуслуги",
        desc: "Разобраться: где мои документы, заявления, штрафы, налоги.",
        due: "2026-08-14",
        proj: "p1",
        pri: 2,
        ass: null,
        labels: [],
      },
      {
        id: "t7",
        title: "Настроить ИИ для семьи",
        desc: "Claude, ChatGPT, Gemini — подключить под FAMILY_USE.",
        due: "2026-08-18",
        proj: "p1",
        pri: 2,
        ass: "u3",
        labels: [],
      },
      {
        id: "t8",
        title: "Оплатить ипотеку — сентябрь",
        desc: "Ежемесячный платёж.",
        due: "2026-09-01",
        proj: "p1",
        pri: 1,
        ass: null,
        labels: ["l1"],
      },
      {
        id: "t9",
        title: "Связаться с банком",
        desc: "Уточнить по графику платежей и текущему остатку долга.",
        due: "2026-08-16",
        proj: "p1",
        pri: 1,
        ass: null,
        labels: ["l1"],
      },
      {
        id: "t10",
        title: "База знаний: единый источник правды и синхронизация через git",
        desc: "С чего начать разговор: спросить Клода «что там с базой знаний?».",
        due: "2026-08-12",
        proj: "p2",
        pri: 3,
        ass: "u2",
        labels: ["l2", "l3"],
      },
      {
        id: "t11",
        title: "Настроить автоматические бэкапы на внешний диск",
        desc: "Ежедневный крон. rsync с дедупликацией.",
        due: "2026-08-13",
        proj: "p2",
        pri: 2,
        ass: "u3",
        labels: ["l3"],
      },
    ];
    const insTask = db.prepare(
      "INSERT INTO tasks (id,title,description,due_date,project_id,priority,assignee_id,creator_id) VALUES (?,?,?,?,?,?,?,?)",
    );
    const insTL = db.prepare(
      "INSERT INTO task_labels (task_id,label_id) VALUES (?,?)",
    );
    for (const t of tasks) {
      insTask.run(t.id, t.title, t.desc, t.due, t.proj, t.pri, t.ass, "u1");
      for (const l of t.labels) insTL.run(t.id, l);
    }

    // Subtasks for t3
    db.prepare(
      "INSERT INTO subtasks (id,task_id,title,position) VALUES (?,?,?,?)",
    ).run(uid(), "t3", "Получить ЭЦП в налоговой", 0);
    db.prepare(
      "INSERT INTO subtasks (id,task_id,title,position) VALUES (?,?,?,?)",
    ).run(uid(), "t3", "Проверить сертификат в личном кабинете", 1);
    // Subtasks for t10
    db.prepare(
      "INSERT INTO subtasks (id,task_id,title,position) VALUES (?,?,?,?)",
    ).run(
      uid(),
      "t10",
      "Слить две папки уроков в одну + включить синхронизацию",
      0,
    );
    db.prepare(
      "INSERT INTO subtasks (id,task_id,title,position) VALUES (?,?,?,?)",
    ).run(uid(), "t10", "Настроить агента для парсинга видеоуроков", 1);

    // Notifications. Every row carries actor_id — who performed the
    // action — so the recipient's list shows a real author avatar instead
    // of the neutral gear placeholder. actor_id is the true doer of the
    // action described in `text`; it happens to equal user_id in n2
    // because that notification genuinely describes Hermes's own action
    // (self-reporting task completion) — not a stand-in for a missing
    // value.
    const notifs = [
      {
        id: "n1",
        user_id: "u2",
        actor_id: "u1", // Максим assigned Claude_Bot to the task
        type: "assigned",
        task_id: "t2",
        text: "Claude_Bot назначен на задачу: Судебное заседание",
      },
      {
        id: "n2",
        user_id: "u3",
        actor_id: "u3", // Hermes completed his own task
        type: "completed",
        task_id: "t7",
        text: "Hermes завершил задачу: Настроить ИИ для семьи",
      },
      {
        id: "n3",
        user_id: "u1",
        actor_id: "u2", // Claude_Bot added this task to Максим's inbox
        type: "new_task",
        task_id: "t1",
        text: "Новая задача назначена вам: Оплатить коммуналку",
      },
    ];
    const insNotif = db.prepare(
      "INSERT INTO notifications (id,user_id,type,task_id,text,actor_id) VALUES (?,?,?,?,?,?)",
    );
    for (const n of notifs)
      insNotif.run(n.id, n.user_id, n.type, n.task_id, n.text, n.actor_id);

    return { ok: true, message: "Seeded" };
  });
}
