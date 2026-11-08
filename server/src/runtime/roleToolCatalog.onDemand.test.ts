import { describe, expect, it } from "vitest";
import { isOnDemandOperation } from "./roleToolCatalog.js";

describe("что грузится по требованию", () => {
  it("инструменты финансового трекера не висят в каждом запросе", () => {
    expect(isOnDemandOperation("wealthfolio_get_accounts")).toBe(true);
    expect(isOnDemandOperation("wealthfolio_record_activity")).toBe(true);
  });

  it("внешние сервисы остаются на том же правиле", () => {
    expect(isOnDemandOperation("things_list_todos")).toBe(true);
    expect(isOnDemandOperation("mcp__composio__gmail_send")).toBe(true);
    expect(isOnDemandOperation("todoist_tasks")).toBe(true);
  });

  it("ядро и инфрапанель остаются активными", () => {
    expect(isOnDemandOperation("taskflow_claim")).toBe(false);
    expect(isOnDemandOperation("mcp__infra__infra_overview")).toBe(false);
  });
});
