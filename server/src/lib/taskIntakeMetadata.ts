// Общая проверка полей постановки для сообщения, диктовки и живого звонка.
export interface IntakeMetadata {
  dueDate: string | null; startTime: string | null; labelIds: string[];
  selfAssigned: boolean; question: string | null;
}
export function parseIntakeMetadata(parsed:any, labels:Array<{id:string;name:string}>):IntakeMetadata {
  const questions:string[]=[];
  const dateText = typeof parsed?.due_date === "string" ? parsed.due_date.trim() : "";
  const [date, legacyTime] = dateText.split(/[ T]/);
  let dueDate:string|null = null;
  if (date) {
    const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    if (parts) {
      const d = new Date(Date.UTC(Number(parts[1]),Number(parts[2])-1,Number(parts[3])));
      if (d.toISOString().slice(0,10)===date) dueDate=date;
    }
    if (!dueDate) questions.push("Уточните дату выполнения задачи.");
  }
  const time = parsed?.start_time ?? legacyTime;
  const startTime = typeof time === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time) && dueDate ? time : null;
  if (time && !startTime) questions.push("Уточните дату и время выполнения задачи.");
  const labelIds:string[]=[];
  if (parsed?.labels != null) {
    if (!Array.isArray(parsed.labels)) questions.push("Уточните метки задачи.");
    else for (const name of parsed.labels.slice(0,20)) {
      const matches=typeof name==="string" ? labels.filter(l=>l.id===name || l.name.trim().toLocaleLowerCase("ru-RU")===name.trim().toLocaleLowerCase("ru-RU")) : [];
      if (matches.length===1) labelIds.push(matches[0].id);
      else questions.push(`Уточните метку «${String(name)}»: она не найдена или неоднозначна.`);
    }
  }
  if (parsed?.assignee != null && parsed.assignee!=="self") questions.push("Уточните исполнителя: владельцу — self, роли — поле role.");
  return {dueDate,startTime,labelIds:[...new Set(labelIds)],selfAssigned:parsed?.assignee==="self",question:questions.join(" ")||null};
}
