import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const sourceFile = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/lib/webhookSubscriptions.ts"
);
const base = path.dirname(sourceFile);

const newPath = path.resolve(base, "..","..","..","scripts","orchestrator","tf_wake_dispatch.py");
const oldPath = path.resolve(base, "..","..","scripts","orchestrator","tf_wake_dispatch.py");

console.log("NEW exists:", fs.existsSync(newPath), "=>", newPath);
console.log("OLD exists:", fs.existsSync(oldPath), "=>", oldPath);

// override-путь
console.log("OVERRIDE env('') exists:", fs.existsSync(process.env.TASKFLOW_CODEX_WAKE_SCRIPT || ""));
