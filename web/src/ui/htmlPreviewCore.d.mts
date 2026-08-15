export const HTML_PREVIEW_CSP: string;
export const HTML_PREVIEW_SANDBOX: string;
export const NEUTRAL_DOWNLOAD_MIME: string;
export function attachmentExtension(filename: unknown): string;
export function isHtmlFilename(filename: unknown): boolean;
export function isHtmlAttachment(filename: unknown, mime?: unknown): boolean;
export function attachmentBlobMime(mime: unknown, filename?: unknown): string;
export function buildSandboxedHtmlDocument(html: unknown): string;
