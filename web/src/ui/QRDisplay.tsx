// QRDisplay — renders an invite string as a scannable QR code.
// Uses the 'qrcode' npm package (toCanvas). The canvas is rendered at 240x240
// and is exposed via data-testid="qr-canvas" so the round-trip test can read
// pixels from it without a screenshot.
import { useEffect, useRef } from 'react';

export function QRDisplay(props: { text: string; size?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { text, size = 240 } = props;

  useEffect(() => {
    if (!canvasRef.current || !text) return;
    const canvas = canvasRef.current;
    // Dynamic import: keeps QR code off the main bundle for non-invite flows.
    void import('qrcode').then((QRCode) => {
      void QRCode.toCanvas(canvas, text, {
        width: size,
        margin: 2,
        errorCorrectionLevel: 'M',
        color: { dark: '#000000', light: '#ffffff' },
      });
    });
  }, [text, size]);

  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'center',
        margin: '8px 0',
      }}
    >
      <canvas
        ref={canvasRef}
        data-testid="qr-canvas"
        data-invite={text}
        width={size}
        height={size}
        style={{
          borderRadius: 8,
          border: '1px solid var(--line)',
          imageRendering: 'pixelated',
        }}
      />
    </div>
  );
}
