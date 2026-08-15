export function isMarkdownFilename(filename: unknown): boolean;
export function formatMarkdownFeedback(selection: unknown, comment: unknown): string;
export function reviewFilename(filename: unknown): string;
export function selectionOccurrence(text: unknown, selection: unknown, startOffset: unknown): number;
export function extractMessageLinks(text: unknown): string[];
export function messageMediaKind(message: { kind?: string; mime?: string } | null | undefined): 'photo' | 'file' | null;
export function groupFileVersions<T extends {
  message: { filename?: string; date?: string };
}>(items: T[]): Array<{ filename: string; versions: T[] }>;
export function formatReviewDocument(
  markdown: unknown,
  comments: Array<{ selection: unknown; comment: unknown; occurrence?: number }>,
): string;
