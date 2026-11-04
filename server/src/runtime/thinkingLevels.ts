export const THINKING_LEVELS = ["off","minimal","low","medium","high","xhigh","max"] as const;
export type ChatThinkingLevel = typeof THINKING_LEVELS[number];
export async function supportedThinkingLevels(model: any): Promise<ChatThinkingLevel[]> {
  const levels = model?.reasoning
    ? THINKING_LEVELS.filter((level) => {
        const mapped = model.thinkingLevelMap?.[level];
        if (mapped === null) return false;
        if (level === "xhigh" || level === "max") return mapped !== undefined;
        return true;
      })
    : ["off"];
  const falseOff = model?.reasoning && (
    (model.provider === "ollama" && model.api === "openai-completions" && model.thinkingLevelMap?.off !== "none") ||
    (model.api === "google-generative-ai" && /^gemini-3/i.test(model.id ?? ""))
  );
  return falseOff ? (levels.filter((level) => level !== "off") as ChatThinkingLevel[]) : (levels as ChatThinkingLevel[]);
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
