import { beforeAll, describe, expect, it } from "vitest";
import db, { migrate } from "../src/db.js";
import { runMigrations } from "../src/migrations.js";
import { seedRoleAccounts } from "./helpers/seedOwner.js";
import { mergedSeconds, missionTime } from "../src/lib/missionTime.js";

const NOW = Date.parse("2026-11-05T12:00:00Z");

function addTask(id: string, parent: string | null = null) {
  db.prepare("INSERT INTO tasks(id,title,description,creator_id,status,parent_id) VALUES(?,?,?,'u1','active',?)").run(id, id, "", parent);
}

function addAttempt(id: string, taskId: string, started: string, ended: string | null, heartbeat: string | null = null) {
  db.prepare("INSERT INTO attempts(id,task_id,executor_id,started_at,ended_at,heartbeat_at) VALUES(?,?,'u1',?,?,?)").run(id, taskId, started, ended, heartbeat);
}

beforeAll(() => {
  migrate();
  runMigrations();
  seedRoleAccounts(db);
});

describe("время миссии", () => {
  it("параллельные попытки не считаются дважды", () => {
    const at = (m: number) => Date.parse("2026-11-05T10:00:00Z") + m * 60_000;
    expect(mergedSeconds([{ start: at(0), end: at(10) }, { start: at(5), end: at(15) }, { start: at(30), end: at(40) }])).toBe(25 * 60);
  });

  it("задача без попыток: ноль и не идёт", () => {
    addTask("mt_empty");
    expect(missionTime("mt_empty", NOW)).toEqual({ started_at: null, worked_seconds: 0, running: false });
  });

  it("считает и дочерние карточки, идущая попытка тянется до сейчас", () => {
    addTask("mt_root");
    addTask("mt_child", "mt_root");
    addAttempt("mt_a1", "mt_root", "2026-11-05 10:00:00", "2026-11-05 10:10:00");
    addAttempt("mt_a2", "mt_child", "2026-11-05T11:50:00Z", null, "2026-11-05T11:59:00Z");
    expect(missionTime("mt_root", NOW)).toEqual({ started_at: "2026-11-05 10:00:00", worked_seconds: 20 * 60, running: true });
  });

  it("брошенная попытка без конца не тикает вечно: обрывается на последнем сигнале", () => {
    addTask("mt_lost");
    addAttempt("mt_a3", "mt_lost", "2026-11-05T08:00:00Z", null, "2026-11-05T08:05:00Z");
    expect(missionTime("mt_lost", NOW)).toEqual({ started_at: "2026-11-05T08:00:00Z", worked_seconds: 5 * 60, running: false });
  });
});
