import { beforeAll, afterEach, describe, expect, it } from "vitest";
import { migrate } from "../src/db.js";
import { runMigrations } from "../src/migrations.js";
import { issueMachineKey } from "../src/host/machines.js";
import { attachHostSocket, handleHostMessage, resetHostGatewaysForTests, runOperation } from "../src/host/gateway.js";
import { HOST_MAX_OUTPUT_BYTES } from "../src/host/protocol.js";

beforeAll(() => { migrate(); runMigrations(); });
afterEach(() => resetHostGatewaysForTests());
function host(name: string) {
  const { machine } = issueMachineKey({ name, allowedRoots: ["/tmp"] });
  const received: any[] = [];
  const socket = { readyState: 1, send(raw: string) { received.push(JSON.parse(raw)); } };
  attachHostSocket(machine, socket);
  return { machine, received, socket };
}
function result(machineId: string, opId: string, stdout = "legitimate") {
  handleHostMessage(machineId, JSON.stringify({ type: "op_result", opId, ok: true, stdout }));
}
describe("server audit: host delivery invariants", () => {
  it("dispatches a side-effecting operation only once when a machine has overlapping sockets", async () => {
    const h = host("audit-duplicate");
    const second: any[] = [];
    attachHostSocket(h.machine, { readyState: 1, send(raw) { second.push(JSON.parse(raw)); } });
    const pending = runOperation(h.machine.id, "bash", { command: "fixture" });
    const ops = [...h.received, ...second].filter(x => x.type === "op");
    result(h.machine.id, ops[0].opId);
    await pending;
    expect(ops).toHaveLength(1);
  });
  it("ignores chunks and results from a different authenticated machine", async () => {
    const h = host("audit-target");
    const other = host("audit-other");
    const chunks: string[] = [];
    const pending = runOperation(h.machine.id, "bash", {}, { onChunk: c => chunks.push(c.data) });
    const opId = h.received[0].opId;
    handleHostMessage(other.machine.id, JSON.stringify({ type: "op_chunk", opId, stream: "stdout", data: "forged" }));
    result(other.machine.id, opId, "forged");
    result(h.machine.id, opId);
    expect(await pending).toMatchObject({ ok: true, stdout: "legitimate" });
    expect(chunks).toEqual([]);
  });
  it("keeps multibyte streamed output within the byte budget", async () => {
    const h = host("audit-bytes");
    const chunks: string[] = [];
    const pending = runOperation(h.machine.id, "bash", {}, { onChunk: c => chunks.push(c.data) });
    const opId = h.received[0].opId;
    handleHostMessage(h.machine.id, JSON.stringify({ type: "op_chunk", opId, stream: "stdout", data: "x".repeat(HOST_MAX_OUTPUT_BYTES - 3) }));
    handleHostMessage(h.machine.id, JSON.stringify({ type: "op_chunk", opId, stream: "stdout", data: "😀😀" }));
    result(h.machine.id, opId);
    expect(await pending).toMatchObject({ ok: true, truncated: true });
    expect(Buffer.byteLength(chunks.join(""))).toBeLessThanOrEqual(HOST_MAX_OUTPUT_BYTES);
    expect(chunks.join("")).not.toContain("�");
  });
});
