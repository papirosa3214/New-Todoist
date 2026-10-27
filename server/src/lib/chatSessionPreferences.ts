import db from "../db.js";
import {resolveCatalogModel,type CatalogModel} from "../runtime/modelCatalog.js";
export type ChatSessionPreferences={model:string|null;thinkingLevel:string|null;configured:boolean};
export function readChatPreferences(chatId:string):ChatSessionPreferences{
 const row=db.prepare("SELECT model,thinking_level FROM chat_session_preferences WHERE chat_id=?").get(chatId) as any;
 return {model:row?.model??null,thinkingLevel:row?.thinking_level??null,configured:!!row};
}
export function writeChatPreferences(chatId:string, body:any, catalog:CatalogModel[], defaultModel:string|null):ChatSessionPreferences{
 const prior=readChatPreferences(chatId);
 const model=Object.hasOwn(body,"model")?body.model:prior.model;
 if(model!==null&&(typeof model!=="string"||!model.trim()))throw new Error("Выберите модель из каталога");
 const effective=resolveCatalogModel(catalog,model??defaultModel);
 const thinking=Object.hasOwn(body,"thinkingLevel")?body.thinkingLevel:
   (prior.thinkingLevel && effective?.thinkingLevels?.includes(prior.thinkingLevel) ? prior.thinkingLevel : null);
 if(thinking!==null&&typeof thinking!=="string")throw new Error("Выберите уровень размышлений");
 if((model!==null||thinking!==null)&&(!effective||effective.available===false))throw new Error("Выбранная модель недоступна");
 if(thinking!==null&&!effective?.thinkingLevels?.includes(thinking))throw new Error("Модель не поддерживает этот уровень размышлений");
 db.prepare("INSERT INTO chat_session_preferences(chat_id,model,thinking_level) VALUES (?,?,?) ON CONFLICT(chat_id) DO UPDATE SET model=excluded.model,thinking_level=excluded.thinking_level").run(chatId,model,thinking);
 return readChatPreferences(chatId);
}
/** Snapshot within the message acceptance transaction; queued work never rereads mutable preferences. */
export function snapshotChatPreferences(messageId:string,chatId:string,requestedModel:string|null){
 const state=readChatPreferences(chatId);
 const model=requestedModel??state.model;
 const thinking=requestedModel&&requestedModel!==state.model?null:state.thinkingLevel;
 if(!state.configured)return;
 db.prepare("UPDATE chat_messages SET model=? WHERE id=?").run(model,messageId);
 db.prepare("INSERT INTO chat_message_preferences(message_id,thinking_level) VALUES (?,?)").run(messageId,thinking);
}
export function messageThinkingLevel(messageId?:string):string|undefined{
 if(!messageId)return undefined;
 return (db.prepare("SELECT thinking_level FROM chat_message_preferences WHERE message_id=?").get(messageId) as any)?.thinking_level??undefined;
}
