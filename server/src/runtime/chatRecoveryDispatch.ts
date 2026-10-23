/** Shared admission for recovery and failure retries. No waiting behind another room. */
type RecoveryRow = {id:string;chat_id:string;role_id:string};
const activePairs = new Set<string>();
let active = 0;
function concurrency(): number {
  const n = Number(process.env.TASKFLOW_CHAT_RECOVERY_CONCURRENCY ?? 4);
  return Number.isFinite(n) && n > 0 ? Math.min(16,Math.floor(n)) : 4;
}
export async function dispatchRecoveryRows<T extends RecoveryRow>(
  rows: T[], execute: (row:T)=>Promise<void>,
): Promise<void> {
  const grouped = new Map<string,T[]>();
  for (const row of rows) {
    const key = JSON.stringify([row.chat_id,row.role_id]);
    const group = grouped.get(key) ?? [];
    group.push(row);
    grouped.set(key,group);
  }
  const groups = [...grouped.entries()];
  let next = 0;
  const worker = async () => {
    while (next < groups.length) {
      if (active >= concurrency()) return; // Other sweeps already occupy the global budget.
      const [key,group] = groups[next++];
      if (activePairs.has(key)) continue;
      activePairs.add(key);
      active++;
      try { for (const row of group) await execute(row); }
      finally { active--; activePairs.delete(key); }
    }
  };
  await Promise.all(Array.from({length:concurrency()},worker));
}
