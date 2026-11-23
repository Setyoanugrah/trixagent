const WEB_CHAT_PREFIX = "web:";

export function isTelegramChat(chatId: string): boolean {
  return !chatId.startsWith(WEB_CHAT_PREFIX);
}

export function isWebChat(chatId: string): boolean {
  return chatId.startsWith(WEB_CHAT_PREFIX);
}

export function notificationChatId(chatId: string, telegramOwnerId: number): string {
  return isTelegramChat(chatId) ? chatId : String(telegramOwnerId);
}
