import db from "../db.js";
import type {ChatMaterial} from "../lib/chatReportMaterials.js";

/** Persist under the durable delivery, so a process restart does not lose a saved document. */
export function prepareReportMaterial(chatId:string,roleId:string,messageId:string,material:ChatMaterial):boolean {
  return db.transaction(()=>{
    const row=db.prepare("SELECT id,payload_json FROM chat_message_queue WHERE chat_id=? AND role_id=? AND message_id=? AND status IN ('pending','picked') ORDER BY rowid DESC LIMIT 1")
      .get(chatId,roleId,messageId) as {id:string;payload_json:string}|undefined;
    if(!row)return false; // Standalone legacy calls still publish their document immediately.
    const payload=JSON.parse(row.payload_json || "{}") ?? {};
    const materials:ChatMaterial[]=Array.isArray(payload.sharedReportMaterials)?payload.sharedReportMaterials:[];
    if(materials.some(item=>item.ref===material.ref))return true;
    if(materials.length>=8)throw new Error("В один итоговый отчёт можно подготовить не больше восьми материалов");
    payload.sharedReportMaterials=[...materials,material];
    db.prepare("UPDATE chat_message_queue SET payload_json=? WHERE id=?").run(JSON.stringify(payload),row.id);
    return true;
  })();
}

export function preparedReportMaterials(chatId:string,roleId:string,messageId:string):ChatMaterial[] {
  const row=db.prepare("SELECT payload_json FROM chat_message_queue WHERE chat_id=? AND role_id=? AND message_id=? ORDER BY rowid DESC LIMIT 1")
    .get(chatId,roleId,messageId) as {payload_json:string}|undefined;
  if(!row)return [];
  const payload=JSON.parse(row.payload_json || "{}");
  return Array.isArray(payload?.sharedReportMaterials)?payload.sharedReportMaterials:[];
}
