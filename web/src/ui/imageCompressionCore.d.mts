export const COMPRESSIBLE_IMAGE_MIMES: readonly string[];
export function isCompressibleImage(mime: unknown, filename?: unknown): boolean;
export function compressedImageFilename(filename: unknown): string;
export function fitWithinBox(
  width: number,
  height: number,
  maxDimension: number,
): { width: number; height: number };
