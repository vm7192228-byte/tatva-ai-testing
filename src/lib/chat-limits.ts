export const CHAT_LIMITS = {
  messagesPerRequest: 60,
  charactersPerMessage: 5_000,
  charactersPerConversation: 64_000,
  attachmentCountPerMessage: 4,
  inlineAttachmentBytes: 2.5 * 1024 * 1024,
  totalAttachmentBytes: 10 * 1024 * 1024,
  extractedTextCharactersPerAttachment: 48_000,
} as const;
