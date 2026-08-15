// Type shim for the qrcode package (no bundled types).
// Covers the subset we actually use: toCanvas and toDataURL.
declare module 'qrcode' {
  export interface QRCodeOptions {
    errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H';
    margin?: number;
    scale?: number;
    width?: number;
    color?: { dark?: string; light?: string };
  }

  /** Render a QR code onto an existing HTMLCanvasElement. */
  export function toCanvas(
    canvas: HTMLCanvasElement,
    text: string,
    options?: QRCodeOptions,
  ): Promise<void>;

  /** Render to a data URL string (PNG by default). */
  export function toDataURL(
    text: string,
    options?: QRCodeOptions,
  ): Promise<string>;
}
