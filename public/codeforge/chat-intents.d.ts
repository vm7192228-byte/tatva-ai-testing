export type ComposerDocumentIntent = "pdf" | null;

export function detectComposerDocumentIntent(prompt: unknown): ComposerDocumentIntent;
