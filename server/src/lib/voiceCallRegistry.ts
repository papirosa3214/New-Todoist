const calls = new Map<string, string>();

export function registerVoiceCall(chatId: string, callId: string): void {
  if (!chatId || !callId) return;
  calls.set(chatId, callId);
}

export function clearVoiceCall(chatId: string): void {
  calls.delete(chatId);
}

export function activeVoiceCallId(chatId: string): string | null {
  return calls.get(chatId) ?? null;
}
