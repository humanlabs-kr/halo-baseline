import { PhotonImage, resize, SamplingFilter } from '@cf-wasm/photon';

/**
 * Downscales an upload before it is stored and sent to the model.
 *
 * Long edge capped at 1280px: receipts are tall and narrow, and beyond this the
 * extra pixels cost storage and vision tokens without making the text any more
 * legible.
 */
const MAX_LONG_EDGE = 1280;
const JPEG_QUALITY = 90;

export function normalizeReceiptImage(rawFile: Uint8Array): Uint8Array {
  let image = PhotonImage.new_from_byteslice(rawFile);

  const width = image.get_width();
  const height = image.get_height();
  const maxDimension = Math.max(width, height);

  if (maxDimension > MAX_LONG_EDGE) {
    const scale = MAX_LONG_EDGE / maxDimension;

    image = resize(image, Math.round(width * scale), Math.round(height * scale), SamplingFilter.Lanczos3);
  }

  // Resize only. Sharpening and contrast tricks make the text look better to a
  // human and measurably worse to the model — do not add them back.
  const jpegBytes = image.get_bytes_jpeg(JPEG_QUALITY);

  image.free();

  return jpegBytes;
}
