import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : process.argv[index + 1] ?? null;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function stateLabel(agentState) {
  return {
    review: "На проверке",
    in_progress: "В работе",
    blocked: "Нужен владелец",
  }[agentState] ?? "Не взята";
}

function stateClass(agentState) {
  return {
    review: "review",
    in_progress: "progress",
    blocked: "blocked",
  }[agentState] ?? "idle";
}

function readSnapshot(input) {
  if (input) return JSON.parse(fs.readFileSync(input, "utf8"));

  const projectRoot = path.resolve(import.meta.dirname, "..");
  const database = path.join(projectRoot, "server", "taskflow.db");
  const query = `SELECT id, title, status, agent_state AS agentState
    FROM tasks WHERE status = 'active' ORDER BY updated_at DESC`;
  const tasks = JSON.parse(execFileSync("sqlite3", ["-json", database, query], { encoding: "utf8" }));
  return { generatedAt: new Date().toISOString(), tasks };
}

function render(snapshot) {
  const tasks = snapshot.tasks ?? [];
  const cards = tasks.map((task) => {
    const id = escapeHtml(task.id.slice(0, 8));
    const title = escapeHtml(task.title);
    const label = stateLabel(task.agentState);
    return `<article class="card ${stateClass(task.agentState)}"><p class="id">${id}</p><h2>${title}</h2><p class="state">${label}</p></article>`;
  }).join("\n");
  const generatedAt = escapeHtml(snapshot.generatedAt);

  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="taskflow-status-source" content="taskflow.db">
  <title>Статус TaskFlow</title>
  <style>
    :root { color-scheme: dark; --bg:#171717; --card:#242424; --stroke:rgba(255,255,255,.09); --text:#fff; --sub:#a6a6a6; --red:#e44332; --blue:#4a9fd8; --orange:#ff9a14; }
    * { box-sizing:border-box; } body { margin:0; padding:32px; background:var(--bg); color:var(--text); font:15px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    main { max-width:1120px; margin:auto; } .eyebrow,.id { margin:0; color:var(--sub); font:12px ui-monospace,SFMono-Regular,Menlo,monospace; letter-spacing:.06em; }
    h1 { margin:8px 0 6px; font-size:28px; } .summary { margin:0 0 28px; color:var(--sub); } .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); gap:12px; }
    .card { min-height:138px; padding:16px; border:1px solid var(--stroke); border-radius:16px; background:var(--card); border-left-width:4px; } .card.idle { border-left-color:var(--sub); } .card.review { border-left-color:var(--blue); } .card.progress { border-left-color:var(--orange); } .card.blocked { border-left-color:var(--red); }
    h2 { margin:14px 0 18px; font-size:17px; line-height:1.3; } .state { margin:0; color:var(--sub); font-size:13px; } footer { margin-top:28px; color:var(--sub); font-size:12px; }
  </style>
</head>
<body><main>
  <p class="eyebrow">TASKFLOW · LIVE STATUS SNAPSHOT</p>
  <h1>Статус TaskFlow</h1>
  <p class="summary">Активных карточек: ${tasks.length}. Срез: ${generatedAt}.</p>
  <section class="grid" aria-label="Активные карточки">${cards}</section>
  <footer>Источник: TaskFlow DB. Статичный маршрут задачи: <a href="taskflow-task-route-map.html">отдельная схема</a>.</footer>
</main></body></html>`;
}

const output = argument("--output") ?? path.resolve(import.meta.dirname, "..", "docs", "taskflow-status-graph.html");
const snapshot = readSnapshot(argument("--input"));
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, render(snapshot));
