// src/lib/liveActivity.ts
// Мост между веб-приложением и нативным ActivityKit (Dynamic Island).

import { registerPlugin } from "@capacitor/core";
import type { ApiTask } from "../api/types";

interface LiveActivityPluginType {
  isAvailable(): Promise<{ available: boolean; enabled: boolean }>;
  startTaskActivity(options: {
    taskId: string;
    taskTitle: string;
    assigneeName?: string;
    assigneeInitials?: string;
    assigneeColor?: string;
    projectName?: string;
    projectColor?: string;
    totalSubtasks?: number;
    doneSubtasks?: number;
    currentSubtask?: string;
    status?: string;
    statusLabel?: string;
    progress?: number;
  }): Promise<{ id: string; taskId: string; started: boolean }>;
  updateTaskActivity(options: {
    taskId: string;
    taskTitle?: string;
    assigneeName?: string;
    assigneeColor?: string;
    projectName?: string;
    projectColor?: string;
    totalSubtasks?: number;
    doneSubtasks?: number;
    currentSubtask?: string;
    status?: string;
    statusLabel?: string;
    progress?: number;
  }): Promise<{ updated: boolean }>;
  endTaskActivity(options?: { taskId?: string }): Promise<{ ended: boolean }>;
  listActivities(): Promise<{ activities: any[] }>;
}

const LiveActivity = registerPlugin<LiveActivityPluginType>("LiveActivity");

export async function isLiveActivityAvailable(): Promise<boolean> {
  try {
    const res = await LiveActivity.isAvailable();
    return res.available && res.enabled;
  } catch {
    return false;
  }
}

function getStatusLabel(task: ApiTask): string {
  if (task.status === "completed") return "Выполнена";
  if (task.agent_state === "review") return "На проверке";
  if (task.agent_state === "blocked") return "Заблокирована";
  if (task.agent_state === "in_progress") return "В работе";
  return "Активна";
}

function getAssigneeName(task: ApiTask): string {
  if (task.assignee_initials === "H") return "Hermes";
  if (task.assignee_initials === "C") return "Claude";
  if (task.assignee_initials === "М") return "Максим";
  return "Агент";
}

export async function syncTaskToLiveActivity(
  task: ApiTask,
  currentSubtaskTitle?: string,
) {
  try {
    const totalSub = task.subtasks.length;
    const doneSub = task.subtasks.filter((s) => s.done).length;
    const activeSub =
      currentSubtaskTitle ||
      task.subtasks.find((s) => !s.done)?.title ||
      undefined;

    const progress = totalSub > 0 ? doneSub / totalSub : task.status === "completed" ? 1.0 : 0.0;
    const status = task.agent_state || (task.status === "completed" ? "completed" : "in_progress");
    const statusLabel = getStatusLabel(task);

    // Если задача выполнена, завершаем Live Activity
    if (task.status === "completed") {
      await LiveActivity.endTaskActivity({ taskId: task.id });
      return;
    }

    // Пробуем обновить существующую активность
    const updateRes = await LiveActivity.updateTaskActivity({
      taskId: task.id,
      taskTitle: task.title,
      assigneeName: getAssigneeName(task),
      assigneeColor: task.assignee_color || "#3A82F6",
      projectName: task.project_name || undefined,
      projectColor: task.project_color || undefined,
      totalSubtasks: totalSub,
      doneSubtasks: doneSub,
      currentSubtask: activeSub,
      status,
      statusLabel,
      progress,
    });

    // Если активности ещё не было и задача в работе / есть подзадачи, создаём новую
    if (!updateRes.updated) {
      await LiveActivity.startTaskActivity({
        taskId: task.id,
        taskTitle: task.title,
        assigneeName: getAssigneeName(task),
        assigneeInitials: task.assignee_initials || "А",
        assigneeColor: task.assignee_color || "#3A82F6",
        projectName: task.project_name || undefined,
        projectColor: task.project_color || undefined,
        totalSubtasks: totalSub,
        doneSubtasks: doneSub,
        currentSubtask: activeSub,
        status,
        statusLabel,
        progress,
      });
    }
  } catch (err) {
    console.debug("LiveActivity sync skipped:", err);
  }
}

export async function stopTaskLiveActivity(taskId?: string) {
  try {
    await LiveActivity.endTaskActivity({ taskId });
  } catch (err) {
    console.debug("LiveActivity stop skipped:", err);
  }
}
