import {
  compressedImageFilename,
  fitWithinBox,
  isCompressibleImage,
} from './imageCompressionCore.mjs';

export interface CompressedImage {
  filename: string;
  mime: 'image/jpeg';
  bytes: Uint8Array;
  width: number;
  height: number;
  originalSize: number;
}

const START_MAX_DIMENSION = 2048;
const MIN_MAX_DIMENSION = 640;
const DIMENSION_STEP = 0.82;
const JPEG_QUALITIES = [0.84, 0.7, 0.56, 0.44];
const TARGET_HEADROOM = 0.94;

function loadImage(file: File): Promise<{ image: HTMLImageElement; release: () => void }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    const release = () => URL.revokeObjectURL(url);
    image.onload = () => resolve({ image, release });
    image.onerror = () => {
      release();
      reject(new Error('This browser could not decode the selected image.'));
    };
    image.src = url;
  });
}

function canvasBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error('This browser could not encode the optimized photo.')),
      'image/jpeg',
      quality,
    );
  });
}

export async function compressImageForSend(file: File, maxBytes: number): Promise<CompressedImage> {
  if (!isCompressibleImage(file.type, file.name)) {
    throw new Error('This image format cannot be optimized safely in this browser.');
  }
  const targetBytes = Math.max(1, Math.floor(maxBytes * TARGET_HEADROOM));
  const { image, release } = await loadImage(file);
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) {
    release();
    throw new Error('Photo optimization is unavailable in this browser.');
  }

  try {
    let dimensionLimit = Math.min(START_MAX_DIMENSION, Math.max(image.naturalWidth, image.naturalHeight));
    while (dimensionLimit >= MIN_MAX_DIMENSION) {
      const dimensions = fitWithinBox(image.naturalWidth, image.naturalHeight, dimensionLimit);
      canvas.width = dimensions.width;
      canvas.height = dimensions.height;
      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);

      for (const quality of JPEG_QUALITIES) {
        const blob = await canvasBlob(canvas, quality);
        if (blob.size <= targetBytes) {
          return {
            filename: compressedImageFilename(file.name),
            mime: 'image/jpeg',
            bytes: new Uint8Array(await blob.arrayBuffer()),
            width: canvas.width,
            height: canvas.height,
            originalSize: file.size,
          };
        }
      }
      dimensionLimit = Math.floor(dimensionLimit * DIMENSION_STEP);
    }
  } finally {
    release();
    canvas.width = 1;
    canvas.height = 1;
  }

  throw new Error('The photo is still too large after optimization.');
}
