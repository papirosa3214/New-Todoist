import { beforeAll, describe, expect, it } from "vitest";
import db, { migrate } from "../src/db.js";
import { runMigrations } from "../src/migrations.js";
import { seedRoleAccounts } from "./helpers/seedOwner.js";
import { buildRoleToolCatalog, piLegacyTaskflowGateway } from "../src/runtime/roleToolCatalog.js";
import { roleToolAllowed } from "../src/lib/roleToolScope.js";
import { inProcessToolNames } from "../src/runtime/inProcessRun.js";

beforeAll(() => {
  migrate();
  runMigrations();
  seedRoleAccounts(db);
});

describe("чистый in-process Pi без legacy-шлюза taskflow", () => {
  it("по умолчанию universal taskflow не в customTools", () => {
    const catalog = buildRoleToolCatalog({ role: "builder", mode: "work", runId: "clean" });
    expect(piLegacyTaskflowGateway("work")).toBe(false);
    expect(catalog.customTools.map((t) => t.name)).not.toContain("taskflow");
    expect(catalog.activeNames).not.toContain("taskflow");
  });

  it("режим voice включает legacy-шлюз", () => {
    const catalog = buildRoleToolCatalog({ role: "secretary", mode: "voice", runId: "voice" });
    expect(piLegacyTaskflowGateway("voice")).toBe(true);
    expect(catalog.customTools.map((t) => t.name)).toContain("taskflow");
  });

  it("экран «Команда» показывает ядро, а не один taskflow", () => {
    const names = inProcessToolNames("builder");
    expect(names).toContain("read");
    expect(names).toContain("taskflow_tools");
    expect(names).not.toContain("taskflow");
  });

  it("Разработчик не получает Mac-хостовые инструменты", () => {
    expect(roleToolAllowed("builder", "taskflow_hosts")).toBe(false);
    expect(roleToolAllowed("builder", "taskflow_host_bash")).toBe(false);
    expect(roleToolAllowed("qa", "taskflow_host_bash")).toBe(true);
  });
});
