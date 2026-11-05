import db from "../db.js";
import {currentResultVersion} from "../resultVersions.js";
import {integrationResponsibility} from "../lib/integrationResponsibility.js";

// Роль на интеграции отменена (владелец 05.11.2026, `acceptedMerge.ts`). Здесь только
// чтение: доставки и шаги, заведённые раньше, должны честно дойти до конца.
const PREFIX="integration-review:";
/** Only a server-created receipt, for the still-current reviewed version, authorizes this continuation. */
export function integrationHandoffContext(messageId:string,roleId:string):string|null {
 if(!messageId.startsWith(PREFIX))return null;
 const review=db.prepare("SELECT r.* FROM reviews r JOIN chat_messages m ON m.id=? AND m.task_id=r.task_id WHERE r.id=? AND r.verdict='approved'").get(messageId,messageId.slice(PREFIX.length)) as any;
 if(!review)return null;
 const task=db.prepare("SELECT parent_id,status,archived_at FROM tasks WHERE id=?").get(review.task_id) as any;
 if(!task || task.parent_id || task.status!=="active" || task.archived_at)return null;
 const state=integrationResponsibility(review.task_id);
 if(state.mode==="not_required" || !state.valid || state.owner_id!==roleId || currentResultVersion(review.task_id)?.id!==review.version_id)return null;
 const queued=db.prepare("SELECT id FROM chat_message_queue WHERE message_id=? AND role_id=? AND delivery_id=?").get(messageId,roleId,messageId);
 if(!queued)return null;
 return `СЕРВЕРНАЯ ПЕРЕДАЧА ПРИНЯТОГО РЕЗУЛЬТАТА. Карточка ${review.task_id}; принятая версия ${review.version_id}; ревью ${review.id}. Вы — уже назначенный ответственный за интеграцию. Это продолжение существующего поручения, не новое назначение и не новый этап. Сначала подтвердите получение в этой переписке. Прочитайте карточку, принятую версию, отчёты и передачу: ветка/worktree, точные коммиты, проверки, миграции, ограничения. Перенос принятого в main делает система автоматически после вашей сдачи шага — от вас нужен разбор и вердикт, а не git-механика: не правьте main и не делайте merge вручную. Не выполняйте разработку повторно. После положительного ревью ваша задача — разбор и вердикт: сверьте принятые коммиты, миграции и совместимость. Сам перенос в main выполняет система (очередь автослияния: временная копия → слияние → тесты → перенос → уборка) после вашей сдачи шага. Не выполняйте merge вручную и не правьте main. Если перенос упёрся в конфликт, система вернёт конфликт вам в вашу же копию — почините и сдайте шаг снова. Для сервера дождитесь завершения очереди; не прерывайте работающих коллег. Перед изменением перепроверьте актуальность версии и своё назначение. При препятствии сохраните причину и контекст передачи в документах/переписке, не выдавайте ожидание за успех. По завершении укажите настоящий SHA main и проверки; выкладка только в рамках поручения. Не закрывайте карточку за владельца, не добавляйте новый обязательный слот или барьер сдачи.`;
}
export function isIntegrationHandoff(messageId:string):boolean{return messageId.startsWith(PREFIX);}

export const INTEGRATION_STEP_MARKER="[taskflow:integration]";
function integrationStepNode(subtaskId:string):{instructions:string;task_id:string}|undefined {
 return db.prepare(`SELECT n.instructions,s.task_id FROM subtasks s JOIN task_collaboration_plan_nodes n ON n.plan_id=s.collaboration_plan_id AND n.slot_key=s.plan_node_key
   WHERE s.id=? AND n.instructions LIKE ?`).get(subtaskId,INTEGRATION_STEP_MARKER+"%") as {instructions:string;task_id:string}|undefined;
}
export function isIntegrationPlanStep(subtaskId:string):boolean{return Boolean(integrationStepNode(subtaskId));}
/** Поручение шага «Интеграция» для задания роли; null — шаг не интеграционный. */
export function integrationStepContext(subtaskId:string):string|null {
 const node=integrationStepNode(subtaskId);
 if(!node)return null;
 const versionId=/version=(\S+)/.exec(node.instructions)?.[1]??"", reviewId=/review=(\S+)/.exec(node.instructions)?.[1]??"";
 if(currentResultVersion(node.task_id)?.id!==versionId)return `ШАГ ИНТЕГРАЦИИ УСТАРЕЛ. Принятая версия ${versionId} больше не актуальна: у карточки появился новый результат. Ничего не переносите в main; заблокируйте шаг с block_type=needs_input и объясните причину.`;
 return `СЕРВЕРНАЯ ПЕРЕДАЧА ПРИНЯТОГО РЕЗУЛЬТАТА. Карточка ${node.task_id}; принятая версия ${versionId}; ревью ${reviewId}. Вы — назначенный ответственный за интеграцию, этот шаг плана и есть интеграция. Прочитайте карточку, принятую версию, отчёты и передачу: ветка/worktree, точные коммиты, проверки, миграции, ограничения. Не выполняйте разработку повторно. ПЕРЕНОС В main ВЫПОЛНЯЕТ СИСТЕМА после вашей сдачи шага (очередь автослияния: временная копия, слияние, тесты, перенос в main, уборка). Ваша часть — судить, а не переносить: сверьте принятые коммиты с задачей, проверьте миграции и совместимость, и если всё в порядке — сдайте шаг обычной сдачей с настоящими SHA ролевых коммитов. Не правьте main и не делайте merge вручную. Если перенос упёрся в конфликт, система вернёт конфликт вам в эту же копию — чините его здесь и сдавайте шаг снова. Принцип «работа роли видна там же, где её сделали» сохраняется: всё, что вы считаете нужным, должно быть закоммичено в рабочую копию карточки (~/.local/state/taskflow-runs/worktrees/<id>). Проверка коммита поверх main для этого шага отключена.`;
}
