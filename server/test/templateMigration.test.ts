import {it,expect} from "vitest";
import db,{migrate} from "../src/db.js";
import {runMigrations} from "../src/migrations.js";
it("template migration preserves plans, nodes, edges, indexes and is idempotent",()=>{
 migrate();runMigrations({through:"153_role_envelope_json"});
 db.prepare("INSERT INTO tasks(id,title,creator_id) VALUES('migration-card','Migration','u1')").run();
 db.prepare("INSERT INTO task_collaboration_plans(id,task_id,revision,profile,rationale,created_by) VALUES('migration-plan','migration-card',1,'research','saved','u1')").run();
 db.prepare("INSERT INTO task_collaboration_plan_nodes(id,plan_id,slot_key,role_key,required,expected_result,instructions) VALUES('migration-node','migration-plan','research','researcher',1,'facts','saved instructions')").run();
 db.prepare("INSERT INTO task_collaboration_plan_nodes(id,plan_id,slot_key,role_key,required,expected_result) VALUES('migration-node2','migration-plan','analysis','analyst',1,'conclusions')").run();
 db.prepare("INSERT INTO task_collaboration_plan_edges(id,plan_id,from_slot_key,to_slot_key,start_condition) VALUES('migration-edge','migration-plan','research','analysis','submitted')").run();
 db.prepare("CREATE INDEX migration_custom_plan_index ON task_collaboration_plans(profile)").run();
 runMigrations();runMigrations();
 expect(db.prepare("SELECT rationale FROM task_collaboration_plans WHERE id='migration-plan'").get()).toEqual({rationale:"saved"});
 expect(db.prepare("SELECT instructions FROM task_collaboration_plan_nodes WHERE id='migration-node'").get()).toEqual({instructions:"saved instructions"});
 expect(db.prepare("SELECT from_slot_key,to_slot_key FROM task_collaboration_plan_edges WHERE id='migration-edge'").get()).toEqual({from_slot_key:"research",to_slot_key:"analysis"});
 expect(db.prepare("SELECT name FROM sqlite_master WHERE name='migration_custom_plan_index'").get()).toBeTruthy();
 expect(db.pragma("foreign_key_check")).toEqual([]);
 for(const profile of ["ux_concept","api_integration","audit"])
   db.prepare("INSERT INTO task_collaboration_plans(id,task_id,revision,profile,rationale,created_by) VALUES(?, 'migration-card', ?, ?, 'new', 'u1')").run(profile,10+profile.length,profile);
 expect(db.pragma("foreign_keys",{simple:true})).toBe(1);
});
