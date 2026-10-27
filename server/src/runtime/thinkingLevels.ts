export const THINKING_LEVELS = ["off","minimal","low","medium","high","xhigh","max"] as const;
export type ChatThinkingLevel = typeof THINKING_LEVELS[number];
let capabilities: Promise<any> | undefined;
/** Read the same capability resolver used by the installed Pi AgentSession. */
export async function supportedThinkingLevels(model: any): Promise<ChatThinkingLevel[]> {
 capabilities ??= import(new URL("../node_modules/@earendil-works/pi-ai/dist/compat.js",import.meta.resolve("@earendil-works/pi-coding-agent")).href);
 const sdk = await capabilities;
 const levels:ChatThinkingLevel[]=sdk.getSupportedThinkingLevels(model);
 // Ollama's Qwen endpoint ignores enable_thinking:false; configured minimal→none
 // sends reasoning_effort:none. Do not label the generic off level as disabled.
 const falseOff=model.reasoning && (
   (model.provider==="ollama" && model.api==="openai-completions" && model.thinkingLevelMap?.off!=="none") ||
   (model.api==="google-generative-ai" && /^gemini-3/i.test(model.id??""))
 );
 return falseOff ? levels.filter(level=>level!=="off") : levels;
}
export async function validateChatThinking(model:any, requested?: string | null):Promise<ChatThinkingLevel | null> {
 if (requested == null) return null;
 if (!(await supportedThinkingLevels(model)).includes(requested as ChatThinkingLevel)) throw new Error("Модель не поддерживает этот уровень размышлений. Выберите доступный уровень.");
 return requested as ChatThinkingLevel;
}

export function thinkingLevelLabels(model:any):Record<string,string>{
 return Object.fromEntries(Object.entries(model.thinkingLevelMap??{})
  .filter(([level,value])=>level!=="off"&&(value==="none"||value==="disabled"))
  .map(([level])=>[level,"Выключены"]));
}
