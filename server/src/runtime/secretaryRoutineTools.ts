import {Type} from "typebox";
import {asRole} from "./inProcessRun.js";

type Factory=(name:string,description:string,parameters:any,run:(p:any)=>Promise<unknown>)=>any;

/** Same authenticated schedule routes as the native client; no owner impersonation. */
export function secretaryRoutineTools(role:string,T:Factory):any[]{
  if(role!=="secretary")return [];
  const text=()=>Type.String({minLength:1});
  const nullable=(schema:any)=>Type.Union([schema,Type.Null()]);
  const optional=(schema:any)=>Type.Optional(schema);
  const object=(fields:any)=>Type.Object(fields,{additionalProperties:false});
  const id={id:text()};
  const kind=Type.Union(['once','daily','weekdays','weekly','weekly_days','monthly','interval'].map(v=>Type.Literal(v)));
  const templateFields={
    title:optional(text()),description:optional(nullable(Type.String())),
    project_id:optional(nullable(text())),assignee_id:optional(nullable(text())),
    priority:optional(Type.Integer({minimum:1,maximum:4})),duration_min:optional(nullable(Type.Integer({minimum:1}))),
    labels:optional(nullable(Type.Array(text()))),requires_reviewer_review:optional(Type.Boolean()),needs_research:optional(Type.Boolean())
  };
  const scheduleFields={
    title:optional(text()),rule_kind:optional(kind),rule_expr:optional(nullable(Type.String())),
    time_local:optional(Type.String({pattern:'^([01][0-9]|2[0-3]):[0-5][0-9]$'})),
    timezone:optional(text()),catch_up:optional(Type.Boolean()),
    overlap_policy:optional(Type.Union([Type.Literal('skip'),Type.Literal('allow')]))
  };
  const path=(p:any)=>'/api/schedules/'+encodeURIComponent(p.id);
  return [
    T('taskflow_routines','Мои рутины: список с полным заданием, расписанием, состоянием и ближайшим запуском. Для изменения, создания, паузы, возобновления, запуска и удаления найди taskflow_routine_* через taskflow_tools по слову «рутины».',object({}),async()=>asRole(role,'GET','/api/schedules')),
    T('taskflow_routine_read','Прочитать рутину: полное задание агенту, исполнитель, расписание, состояние и история запусков. Перед изменением сначала прочитай текущие настройки.',object(id),async p=>asRole(role,'GET',path(p))),
    T('taskflow_routine_create','Создать рутину по поручению владельца: будущее регулярное или однократное задание. rule_expr: once — ГГГГ-ММ-ДД; weekly_days — 1,3,5; weekly — 1..7; monthly — 1..31; interval — 15m или 2h, минимум 5 минут. assignee_id — ключ роли. Метки — имена. По умолчанию зона Europe/Moscow. Создание само не запускает выполнение сейчас.',
      object({...scheduleFields,title:text(),rule_kind:kind,time_local:Type.String({pattern:'^([01][0-9]|2[0-3]):[0-5][0-9]$'}),task_payload:object({...templateFields,title:text()})}),
      async p=>asRole(role,'POST','/api/schedules',p)),
    T('taskflow_routine_update','Изменить рутину по поручению владельца: задание, исполнителя, расписание и параметры будущих запусков. Передавай только изменяемые поля; остальные сохраняются. В task_payload description — полное задание; null снимает необязательное поле. Уже созданные задачи не меняются. status=finished завершает рутину.',
      object({...id,...scheduleFields,status:optional(Type.Union([Type.Literal('active'),Type.Literal('paused'),Type.Literal('finished')])),task_payload:optional(object(templateFields))}),
      async p=>{const {id,...changes}=p;return asRole(role,'PATCH',path({id}),changes);}),
    T('taskflow_routine_pause','Поставить рутину на паузу: новые задачи по ней не создаются. Уже созданные задачи остаются.',object(id),async p=>asRole(role,'PATCH',path(p),{status:'paused'})),
    T('taskflow_routine_resume','Возобновить рутину после паузы: сервер пересчитает следующий запуск по сохранённому расписанию.',object(id),async p=>asRole(role,'PATCH',path(p),{status:'active'})),
    T('taskflow_routine_run_now','Запустить рутину сейчас по явному поручению владельца. Создаёт реальную задачу вне расписания. Рутину на паузе сначала нужно возобновить; skip может пропустить запуск, если предыдущая задача ещё не закрыта. Верни фактический результат и ссылку на созданную задачу.',object(id),async p=>asRole(role,'POST',path(p)+'/run-now',{})),
    T('taskflow_routine_delete','Удалить рутину только по явному поручению владельца. Прекращает её будущие запуски, уже созданные задачи сохраняются. Для временной остановки используй taskflow_routine_pause.',object(id),async p=>asRole(role,'DELETE',path(p))),
    T('taskflow_routine_runs','История запусков рутины: созданные задачи, ошибки и причины пропусков.',object(id),async p=>asRole(role,'GET',path(p)+'/runs')),
    T('taskflow_routine_preview','Предпросмотр правила рутины и ближайшего запуска без создания или изменения. rule_expr зависит от rule_kind, как у taskflow_routine_create.',object({rule_kind:kind,rule_expr:optional(nullable(Type.String())),time_local:scheduleFields.time_local,timezone:scheduleFields.timezone}),async p=>{
      const query=new URLSearchParams();for(const [key,value] of Object.entries(p))if(value!==null && value!==undefined)query.set(key,String(value));
      return asRole(role,'GET','/api/schedules/preview?'+query);
    })
  ];
}
