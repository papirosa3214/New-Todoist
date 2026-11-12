import { describe, expect, it, beforeEach } from "vitest";
import {
  REA_PREFIX,
  reaMacHost,
  reaRemoteWorkdir,
  reaRoleAllowed,
  reaToolName,
} from "./reaMcp.js";
import { isOnDemandOperation } from "./roleToolCatalog.js";

describe("REA MCP", () => {
  beforeEach(() => {
    delete process.env.TASKFLOW_REA_SSH_HOST;
    delete process.env.TASKFLOW_REA_WORKDIR;
  });

  it("доступен исследователю и инженеру, остальным — нет", () => {
    expect(reaRoleAllowed("researcher")).toBe(true);
    expect(reaRoleAllowed("infra_engineer")).toBe(true);
    expect(reaRoleAllowed("builder")).toBe(false);
    expect(reaRoleAllowed("secretary")).toBe(false);
  });

  it("имя инструмента получает префикс — иначе он не уйдёт в загрузку по требованию", () => {
    expect(reaToolName("open_binary")).toBe("rea_open_binary");
    expect(reaToolName("procedure_pseudo_code").startsWith(REA_PREFIX)).toBe(true);
  });

  it("префикс rea_ в списке по требованию: 42 схемы не висят в каждом запросе", () => {
    expect(isOnDemandOperation("rea_open_binary")).toBe(true);
  });

  it("хост мака и рабочая папка: env перекрывает умолчания", () => {
    expect(reaMacHost()).toBe("maksim@192.168.1.102");
    process.env.TASKFLOW_REA_SSH_HOST = "maksim@10.0.0.5";
    expect(reaMacHost()).toBe("maksim@10.0.0.5");

    expect(reaRemoteWorkdir()).toBe("~");
    process.env.TASKFLOW_REA_WORKDIR = "~/targets";
    expect(reaRemoteWorkdir()).toBe("~/targets");
  });
});
