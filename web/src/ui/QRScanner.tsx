// QRScanner — in-app camera QR scanner.
// Uses getUserMedia + jsQR (pure JS, works on ImageData) in a decode loop.
// No native camera app involved — the whole scan→decode flow happens in-app.
//
// Usage:
//   <QRScanner onDecode={(text) => ...} onClose={() => ...} />
//
// Feature-detect getUserMedia; permission-denied or no-camera → friendly
// message + paste fallback (the caller's onClose keeps the paste path open).
// ALL media tracks are stopped on unmount, close, or successful decode.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from './icons';

type ScanState = 'requesting' | 'scanning' | 'denied' | 'nocamera' | 'error';

export function QRScanner(props: {
  onDecode: (text: string) => void;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number>(0);
  const mountedRef = useRef(true);

  const [state, setState] = useState<ScanState>('requesting');
  const [errMsg, setErrMsg] = useState('');

  // Stop all camera tracks and cancel the decode loop.
  const stopCamera = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  // Decode loop: grab a frame from the video into the canvas, run jsQR on it.
  // Runs via requestAnimationFrame so it's gentle on CPU.
  const startDecodeLoop = useCallback((stream: MediaStream) => {
    streamRef.current = stream;
    const video = videoRef.current!;
    video.srcObject = stream;
    video.setAttribute('playsinline', 'true'); // iOS Safari
    void video.play();

    const canvas = canvasRef.current!;
    const ctx = canvas.getContext('2d')!;

    const tick = () => {
      if (!mountedRef.current) return;
      if (video.readyState >= video.HAVE_ENOUGH_DATA) {
        const w = video.videoWidth || 320;
        const h = video.videoHeight || 240;
        canvas.width = w;
        canvas.height = h;
        ctx.drawImage(video, 0, 0, w, h);
        const imageData = ctx.getImageData(0, 0, w, h);
        // Dynamic import: lazy-load jsQR so it doesn't hit the main bundle.
        void import('jsqr').then((mod) => {
          const jsQR = mod.default;
          const result = jsQR(imageData.data, imageData.width, imageData.height, {
            inversionAttempts: 'dontInvert',
          });
          if (result && result.data && mountedRef.current) {
            stopCamera();
            props.onDecode(result.data);
            return;
          }
          if (mountedRef.current) {
            rafRef.current = requestAnimationFrame(tick);
          }
        });
      } else {
        rafRef.current = requestAnimationFrame(tick);
      }
    };

    rafRef.current = requestAnimationFrame(tick);
  }, [stopCamera, props]);

  useEffect(() => {
    mountedRef.current = true;

    // Feature-detect getUserMedia (not available in some older browsers or when
    // the page is served over HTTP without a secure context).
    if (!navigator.mediaDevices?.getUserMedia) {
      setState('nocamera');
      return;
    }

    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'environment' } })
      .then((stream) => {
        if (!mountedRef.current) { stream.getTracks().forEach((t) => t.stop()); return; }
        setState('scanning');
        startDecodeLoop(stream);
      })
      .catch((err: unknown) => {
        if (!mountedRef.current) return;
        const name = (err as { name?: string }).name ?? '';
        if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
          setState('denied');
        } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
          setState('nocamera');
        } else {
          setState('error');
          setErrMsg((err as Error).message ?? String(err));
        }
      });

    return () => {
      mountedRef.current = false;
      stopCamera();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleClose = () => {
    stopCamera();
    props.onClose();
  };

  return (
    <div
      data-testid="qr-scanner"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        padding: '12px 0',
      }}
    >
      {(state === 'requesting' || state === 'scanning') && (
        <>
          <p className="muted" style={{ margin: 0, fontSize: '0.88rem' }}>
            {state === 'requesting' ? 'Requesting camera…' : 'Point your camera at the QR code.'}
          </p>
          <div style={{ position: 'relative', borderRadius: 8, overflow: 'hidden', background: '#000', minHeight: 200 }}>
            {/* Hidden canvas for frame capture — not shown to the user */}
            <canvas
              ref={canvasRef}
              data-testid="scanner-canvas"
              style={{ display: 'none' }}
            />
            {/* Visible video preview */}
            <video
              ref={videoRef}
              data-testid="scanner-video"
              muted
              playsInline
              style={{ width: '100%', display: 'block', borderRadius: 8 }}
            />
            {state === 'scanning' && (
              <div style={{
                position: 'absolute', inset: 0, pointerEvents: 'none',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <div style={{
                  width: 160, height: 160, borderRadius: 12,
                  border: '2px solid var(--accent)',
                  boxShadow: '0 0 0 9999px rgba(0,0,0,0.4)',
                }} />
              </div>
            )}
          </div>
        </>
      )}

      {state === 'denied' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-2)' }}>
            <Icon name="shield" size={16} />
            <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>Camera access denied</span>
          </div>
          <p className="muted" style={{ margin: 0, fontSize: '0.88rem' }}>
            Camera permission was denied. To scan QR codes, allow camera access in your browser
            settings, then try again. Or paste the invite text below instead.
          </p>
        </div>
      )}

      {state === 'nocamera' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-2)' }}>
            <Icon name="close" size={16} />
            <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>No camera available</span>
          </div>
          <p className="muted" style={{ margin: 0, fontSize: '0.88rem' }}>
            No camera was found on this device. Paste the invite text below instead.
          </p>
        </div>
      )}

      {state === 'error' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--danger, #e53)' }}>
            Camera error: {errMsg || 'unknown error'}. Paste the invite text below instead.
          </p>
        </div>
      )}

      <button className="btn" style={{ justifyContent: 'center' }} onClick={handleClose}>
        {state === 'scanning' ? (
          <><Icon name="close" size={14} />Cancel scan</>
        ) : (
          <><Icon name="close" size={14} />Close scanner</>
        )}
      </button>
    </div>
  );
}
