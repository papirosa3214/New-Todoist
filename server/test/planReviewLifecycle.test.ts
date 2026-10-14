import { roleReport } from "./helpers/roleReport.js";
import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, it, expect, vi } from 'vitest';
vi.mock('../src/runtime/inProcessRun.js', async (importOriginal) => ({ ...await importOriginal<typeof import('../src/runtime/inProcessRun.js')>(), runRoleInProcess: vi.fn(async () => ({ runId: 'plan-test-run', completion: Promise.resolve() })) }));
import db from '../src/db.js';
import { buildApp } from '../src/index.js';
import { seedRoleAccounts, demoteSeededOwner } from './helpers/seedOwner.js';
import { finishPlanIfComplete, unlockReadyPlanSubtasks } from '../src/runtime/planSubtaskAdmission.js';
import { completePlanFinalReview, ensurePlanFinalReviewer, planReworkGraph, markPlanFinalReviewerStarted } from '../src/runtime/planReviewLifecycle.js';
import { currentResultVersion } from '../src/resultVersions.js';
describe('visible final critic and actual rework graph', () => {
    let app: Awaited<ReturnType<typeof buildApp>>, owner: string, auth: Record<string, string>;
    beforeAll(async () => { app = await buildApp(); demoteSeededOwner(db); seedRoleAccounts(db); db.prepare("UPDATE users SET reviewer=1 WHERE id='role_critic_verifier'").run(); owner = `cycle-owner-${crypto.randomUUID()}`; db.prepare("INSERT INTO users(id,name,email,password_hash,role,type) VALUES(?,'Cycle owner',?,'!','owner','human')").run(owner, `${owner}@test`); auth = { authorization: `Bearer ${app.jwt.sign({ id: owner })}` }; });
    afterAll(async () => { await app.close(); });
    async function fixture(parallel = false) {
        const task = (await app.inject({ method: 'POST', url: '/api/tasks', headers: auth, payload: { title: 'Cycle demo' } })).json().task.id as string;
        db.prepare("UPDATE tasks SET assignee_id='role_researcher',requires_reviewer_review=1 WHERE id=?").run(task);
        const plan = (await app.inject({ method: 'POST', url: `/api/tasks/${task}/collaboration-plans`, headers: auth, payload: { profile: 'manual', nodes: [{ slot_key: 'research', role_key: 'researcher', expected_result: 'Документ с фактами' }, { slot_key: 'analysis', role_key: 'analyst', expected_result: 'Проверенные выводы' }], edges: parallel ? [] : [{ from_slot_key: 'research', to_slot_key: 'analysis', start_condition: 'submitted' }] } })).json().plan.id as string;
        const responsibility = await app.inject({ method: 'PATCH', url: `/api/tasks/${task}/integration-responsibility`, headers: auth, payload: { mode: 'manual', owner_id: 'role_researcher' } });
        expect(responsibility.statusCode).toBe(200);
        const approved = await app.inject({ method: 'POST', url: `/api/tasks/${task}/collaboration-plans/${plan}/approve`, headers: auth });
        expect(approved.statusCode).toBe(200);
        db.prepare("UPDATE subtasks SET done=1,agent_state=NULL,result='initial result' WHERE collaboration_plan_id=?").run(plan);
        expect(finishPlanIfComplete(plan, task, owner)).toBe(true);
        const critic = ensurePlanFinalReviewer(plan, task);
        return { task, plan, critic };
    }
    it('attaches one queued critic with incoming arrow, without launching another hidden verifier', async () => {
        const { task, plan, critic } = await fixture();
        expect(ensurePlanFinalReviewer(plan, task).id).toBe(critic.id);
        expect(db.prepare('SELECT from_slot_key FROM task_collaboration_plan_edges WHERE plan_id=? AND to_slot_key=?').all(plan, critic.plan_node_key)).toEqual([{ from_slot_key: 'analysis' }]);
        expect(db.prepare("SELECT COUNT(*) n FROM role_run_jobs WHERE task_id=? AND reason='review'").get(task)).toEqual({ n: 1 });
        markPlanFinalReviewerStarted(task);
        expect(db.prepare('SELECT agent_state FROM subtasks WHERE id=?').get(critic.id)).toEqual({ agent_state: 'in_progress' });
    });
    it('replays a sequential segment, queues new-version recheck and keeps the previous results', async () => {
        const { task, plan, critic } = await fixture();
        const v1 = currentResultVersion(task)!;
        const criticAuth = { authorization: `Bearer ${app.jwt.sign({ id: 'role_critic_verifier' })}` };
        const body = { report_markdown: roleReport, task_id: task, version_id: v1.id, task_revision: v1.task_revision, artifact_hash: v1.artifact_hash, criteria_version: '1', verdict: 'changes_requested', findings: 'Нет документа с фактами', rework_steps: ['research'] };
        const response = await app.inject({ method: 'POST', url: '/api/reviews', headers: criticAuth, payload: body });
        expect(response.statusCode).toBe(201);
        expect(response.json().handled_by_plan).toBe(true);
        const duplicate = await app.inject({ method: 'POST', url: '/api/reviews', headers: criticAuth, payload: body });
        expect(duplicate.statusCode).toBe(201);
        const cycle = db.prepare("SELECT slot_key,role_key FROM task_collaboration_plan_nodes WHERE plan_id=? AND origin='rework' ORDER BY rowid").all(plan) as Array<{
            slot_key: string;
            role_key: string;
        }>;
        expect(cycle.map(n => n.role_key)).toEqual(['researcher', 'analyst', 'critic_verifier']);
        const links = db.prepare('SELECT from_slot_key,to_slot_key FROM task_collaboration_plan_edges WHERE plan_id=?').all(plan) as Array<{
            from_slot_key: string;
            to_slot_key: string;
        }>;
        expect(links).toEqual(expect.arrayContaining([{ from_slot_key: critic.plan_node_key, to_slot_key: cycle[0].slot_key }, { from_slot_key: cycle[0].slot_key, to_slot_key: cycle[1].slot_key }, { from_slot_key: cycle[1].slot_key, to_slot_key: cycle[2].slot_key }]));
        expect(db.prepare("SELECT done FROM subtasks WHERE collaboration_plan_id=? AND plan_node_key IN ('research','analysis')").all(plan)).toEqual([{ done: 1 }, { done: 1 }]);
        expect(db.prepare("SELECT COUNT(*) n FROM comments WHERE task_id=? AND user_id='role_critic_verifier'").get(task)).toEqual({ n: 1 });
        db.prepare("UPDATE subtasks SET done=1,agent_state=NULL,result='updated document' WHERE collaboration_plan_id=? AND plan_node_key=?").run(plan, cycle[0].slot_key);
        await unlockReadyPlanSubtasks(plan, task, owner);
        expect(db.prepare('SELECT agent_state FROM subtasks WHERE collaboration_plan_id=? AND plan_node_key=?').get(plan, cycle[1].slot_key)).toEqual({ agent_state: 'in_progress' });
        db.prepare("UPDATE subtasks SET done=1,agent_state=NULL,result='updated conclusions' WHERE collaboration_plan_id=? AND plan_node_key=?").run(plan, cycle[1].slot_key);
        await unlockReadyPlanSubtasks(plan, task, owner);
        const v2 = currentResultVersion(task)!;
        expect(v2.id).not.toBe(v1.id);
        expect(v2.version_no).toBe(2);
        expect(() => planReworkGraph(plan,cycle[2].slot_key,['research'])).toThrow('исторический');
        const recheckJobs = db.prepare("SELECT COUNT(*) n FROM role_run_jobs WHERE task_id=? AND reason='review'").get(task);
        expect(recheckJobs).toEqual({ n: 2 });
    });
    it('rejects two sequential recipients and permits two independent parallel arrows', async () => {
        const sequential = await fixture();
        expect(() => planReworkGraph(sequential.plan, sequential.critic.plan_node_key, ['research', 'analysis'])).toThrow('Последовательные');
        const parallel = await fixture(true);
        const route = planReworkGraph(parallel.plan, parallel.critic.plan_node_key, ['research', 'analysis']);
        expect(route.work).toHaveLength(2);
        completePlanFinalReview(parallel.task, 'role_critic_verifier', 'changes_requested', 'Нужны оба документа', ['research', 'analysis']);
        expect(db.prepare('SELECT COUNT(*) n FROM task_collaboration_plan_edges WHERE plan_id=? AND from_slot_key=?').get(parallel.plan, parallel.critic.plan_node_key)).toEqual({ n: 2 });
    });
    it('keeps review rounds separate and stops after two rework cycles', async () => {
        const {task,plan,critic}=await fixture();
        completePlanFinalReview(task,'role_critic_verifier','changes_requested','Fix document',['research']);
        const first=db.prepare("SELECT slot_key FROM task_collaboration_plan_nodes WHERE plan_id=? AND role_key='researcher' AND iteration=1").get(plan) as {slot_key:string};
        const firstRecheck=ensurePlanFinalReviewer(plan,task);
        completePlanFinalReview(task,'role_critic_verifier','changes_requested','Fix again',[first.slot_key]);
        const second=db.prepare("SELECT slot_key FROM task_collaboration_plan_nodes WHERE plan_id=? AND role_key='researcher' AND iteration=2").get(plan) as {slot_key:string};
        expect(db.prepare('SELECT from_slot_key FROM task_collaboration_plan_edges WHERE plan_id=? AND to_slot_key=?').all(plan,second.slot_key)).toEqual([{from_slot_key:firstRecheck.plan_node_key}]);
        expect(firstRecheck.plan_node_key).not.toBe(critic.plan_node_key);
        const count=db.prepare('SELECT COUNT(*) n FROM task_collaboration_plan_nodes WHERE plan_id=?').get(plan);
        completePlanFinalReview(task,'role_critic_verifier','changes_requested','Needs owner',[second.slot_key]);
        expect(db.prepare('SELECT COUNT(*) n FROM task_collaboration_plan_nodes WHERE plan_id=?').get(plan)).toEqual(count);
        expect(db.prepare('SELECT agent_state FROM tasks WHERE id=?').get(task)).toEqual({agent_state:'blocked'});
    });

    it('owner return of a plan task without assignee goes to the critic, not to agent_inbox', async () => {
        const { task, plan, critic } = await fixture();
        completePlanFinalReview(task, 'role_critic_verifier', 'approved', 'ok');
        db.prepare("UPDATE tasks SET assignee_id=NULL,agent_state='review' WHERE id=?").run(task);
        const before = (db.prepare("SELECT COUNT(*) n FROM agent_inbox WHERE task_id=?").get(task) as { n: number }).n;
        const res = await app.inject({ method: 'POST', url: `/api/tasks/${task}/state`, headers: auth, payload: { state: 'in_progress', comment: 'Помощник не показал виджеты' } });
        expect(res.statusCode, res.body).toBe(200);
        const step = db.prepare("SELECT n.slot_key, n.instructions, s.agent_state FROM task_collaboration_plan_nodes n JOIN subtasks s ON s.collaboration_plan_id=n.plan_id AND s.plan_node_key=n.slot_key WHERE n.plan_id=? AND n.slot_key LIKE 'owner_return_%'").get(plan) as any;
        expect(step.instructions).toContain('Помощник не показал виджеты');
        expect(step.agent_state).toBe('todo');
        expect(critic.plan_node_key).not.toBe(step.slot_key);
        expect((db.prepare("SELECT COUNT(*) n FROM agent_inbox WHERE task_id=?").get(task) as { n: number }).n).toBe(before);
    });
});
