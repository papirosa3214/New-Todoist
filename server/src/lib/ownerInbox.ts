// Read-only projection of current requests, never a log of old notifications.
import db from "../db.js";
import { isOwner, getTaskForRead } from "../access.js";
import { questionAddressAlive, questionEnvelope, type QuestionRow } from "./chatQuestions.js";
export interface OwnerInboxTicket {
    id: string;
    kind: "question" | "approval" | "decision";
    title: string;
    body: string;
    role: string | null;
    role_id: string | null;
    task_id: string | null;
    chat_id: string | null;
    context_title: string | null;
    project: string | null;
    created_at: string;
    question?: Record<string, unknown> | null;
}
type Task = {
    id: string;
    title: string;
    project: string | null;
    created_at: string;
    updated_at: string;
    request_created_at: string;
    decision_created_at: string;
    agent_state: string | null;
    blocked_reason: string | null;
    needs_clarification: number;
    clarification_question: string | null;
    role: string | null;
    role_id: string | null;
};
const ownerWait = (s: string) => /на усмотрение владельца|жд[её]т.{0,25}владельца|(?:решени[еяю]|ответ|разрешени[еяю]|согласовани[еяю]).{0,35}владельц|владел[еь]ц.{0,35}(?:реш|ответ|разреш|соглас)|owner.{0,25}(?:decision|input|approval)|(?:awaiting|waiting).{0,15}owner/iu.test(s);
export function ownerInbox(userId: string): OwnerInboxTicket[] {
    if (!isOwner(userId))
        return [];
    const tasks = db.prepare(`SELECT t.*,p.name AS project,
 COALESCE((SELECT j.updated_at FROM task_preparation_jobs j WHERE j.task_id=t.id AND j.status='needs_clarification' ORDER BY j.id DESC LIMIT 1),
 (SELECT e.created_at FROM task_events e WHERE e.task_id=t.id AND e.field='clarification_question' ORDER BY e.created_at DESC LIMIT 1),t.created_at) AS request_created_at,
 COALESCE(t.blocked_at,(SELECT e.created_at FROM task_events e WHERE e.task_id=t.id AND (e.kind='plan_rework_requires_owner' OR (e.field='agent_state' AND e.to_value='blocked')) ORDER BY e.created_at DESC LIMIT 1),t.created_at) AS decision_created_at,
 COALESCE((SELECT u.name FROM subtasks s JOIN users u ON u.id=s.agent_id WHERE s.task_id=t.id AND s.done=0 AND s.agent_state='blocked' ORDER BY s.position DESC LIMIT 1),u.name) AS role,
 COALESCE((SELECT s.agent_id FROM subtasks s WHERE s.task_id=t.id AND s.done=0 AND s.agent_state='blocked' ORDER BY s.position DESC LIMIT 1),t.assignee_id,
 (SELECT executor_id FROM attempts WHERE task_id=t.id ORDER BY started_at DESC LIMIT 1)) AS role_id
 FROM tasks t LEFT JOIN projects p ON p.id=t.project_id LEFT JOIN users u ON u.id=t.assignee_id
 WHERE t.status='active' AND t.archived_at IS NULL AND p.archived_at IS NULL`).all() as Task[];
    const byId = new Map(tasks.filter(t => getTaskForRead(t.id, userId)).map(t => [t.id, t]));
    const tickets: OwnerInboxTicket[] = [];
    const add = (t: Task, id: string, kind: OwnerInboxTicket["kind"], title: string, body: string, created_at: string, role_id = t.role_id, role = t.role) => {
        tickets.push({ id, kind, title, body, created_at, role_id, role, task_id: t.id, chat_id: null, context_title: t.title, project: t.project });
    };
    const questions = db.prepare(`SELECT q.*,c.title AS chat_title,c.task_id,u.name AS role
 FROM chat_questions q JOIN chats c ON c.id=q.chat_id LEFT JOIN users u ON u.id=q.role_id LEFT JOIN projects cp ON cp.id=c.project_id
 WHERE cp.archived_at IS NULL AND q.status='open' AND (q.deadline_at IS NULL OR julianday(q.deadline_at)>julianday('now'))
 AND EXISTS(SELECT 1 FROM chat_members cm WHERE cm.chat_id=q.chat_id AND cm.member_id=?)
 ORDER BY q.created_at DESC`).all(userId) as (QuestionRow & {
        chat_title: string | null;
        task_id: string | null;
        role: string | null;
    })[];
    for (const q of questions) {
        const t = q.task_id ? byId.get(q.task_id) : null;
        if (q.task_id && !t)
            continue;
        // Адресат вопроса должен быть жив: закрытый или убранный чат,
        // удалённая либо архивная карточка означают, что ответить некуда и
        // вопрос не должен висеть в «Нужен ответ» (31.10.2026).
        if (!questionAddressAlive(q.chat_id))
            continue;
        try {
            const question = questionEnvelope(q);
            const items = question?.questions as {
                question: string;
            }[] | undefined;
            if (!items?.length)
                continue;
            tickets.push({ id: "question:" + q.id, kind: "question", title: items[0].question, body: items.slice(1).map(x => x.question).join("\n"), role: q.role, role_id: q.role_id, task_id: q.task_id, chat_id: q.chat_id, context_title: t?.title ?? q.chat_title, project: t?.project ?? null, created_at: q.created_at, question });
        }
        catch { /* A malformed legacy question must not hide other requests. */ }
    }
    for (const t of byId.values()) {
        if (t.needs_clarification && t.clarification_question?.trim())
            add(t, "clarification:" + t.id, "question", t.clarification_question.trim(), "Требуется уточнение задачи", t.request_created_at);
        else if (t.agent_state === "blocked" && t.blocked_reason && ownerWait(t.blocked_reason))
            add(t, "decision:" + t.id, "decision", t.blocked_reason, "Нужно ваше решение для продолжения работы", t.decision_created_at);
    }
    const steps = db.prepare(`SELECT s.id,s.task_id,s.title,s.result,s.agent_id,s.blocked_at,u.name AS role
 FROM subtasks s LEFT JOIN users u ON u.id=s.agent_id WHERE s.done=0 AND s.agent_state='blocked' AND s.block_type='needs_input'`).all() as {
        id: string;
        task_id: string;
        title: string;
        result: string | null;
        agent_id: string | null;
        blocked_at: string | null;
        role: string | null;
    }[];
    for (const s of steps) {
        const t = byId.get(s.task_id);
        if (!t)
            continue;
        add(t, "step:" + s.id, "decision", s.result?.trim() || s.title, "Агент ждёт ваших данных или решения", s.blocked_at ?? t.created_at, s.agent_id, s.role);
    }
    const plans = db.prepare(`SELECT p.id,p.task_id,p.status,p.created_at,p.created_by,p.rationale,u.name AS role FROM task_collaboration_plans p LEFT JOIN users u ON u.id=p.created_by
 WHERE p.status='draft' AND NOT EXISTS(SELECT 1 FROM task_collaboration_plans newer WHERE newer.task_id=p.task_id AND newer.revision>p.revision)`).all() as {
        id: string;
        task_id: string;
        status: string;
        created_at: string;
        created_by: string;
        role: string | null;
        rationale: string;
    }[];
    for (const p of plans) {
        const t = byId.get(p.task_id);
        if (!t || t.agent_state === "in_progress" || tickets.some(x => x.id === "clarification:" + t.id))
            continue;
        add(t, "plan:" + p.id, "approval", "Согласовать план работы", p.rationale || "Проверьте этапы и исполнителей перед запуском", p.created_at, p.created_by, p.role);
    }
    const ops = db.prepare(`SELECT o.id,p.task_id,o.created_at,o.actor_id,u.name AS role,o.reason
 FROM task_collaboration_plan_ops o JOIN task_collaboration_plans p ON p.id=o.plan_id LEFT JOIN users u ON u.id=o.actor_id
 WHERE o.status='proposed' AND p.status='approved'`).all() as {
        id: string;
        task_id: string;
        created_at: string;
        actor_id: string | null;
        role: string | null;
        reason: string | null;
    }[];
    for (const o of ops) {
        const t = byId.get(o.task_id);
        if (t)
            add(t, "plan-op:" + o.id, "approval", "Согласовать изменение плана", o.reason || "Роль предложила изменение. Рассмотрите его в плане задачи.", o.created_at, o.actor_id, o.role);
    }
    // Drop only an exact textual duplicate of a task-level block; independent steps keep their own IDs.
    const unique = tickets.filter(x => !x.id.startsWith("decision:") || !tickets.some(y => y.id.startsWith("step:") && y.task_id === x.task_id && y.title.trim() === x.title.trim()));
    return unique.sort((a, b) => b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id));
}
