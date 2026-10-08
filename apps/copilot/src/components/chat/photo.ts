/**
 * Browser-only helpers that prepare a camera photo before it enters the
 * normal attachment path (`onAttach(file)` -> `uploadDocument` -> consent ->
 * intake). No React in here, and no network: the file this module returns is
 * handed to the same `onAttach` the paperclip uses, so nothing about what is
 * sent to a model changes (spec/madar/08 §E).
 *
 * Why it exists (T-38): a modern phone camera produces a 12-48 megapixel
 * JPEG of 5-15 MB. `src/intake/upload.ts` refuses any upload above 10 MB and
 * `src/llm/vision.ts` refuses an image above 10 MB of base64 (about 7.5 MB
 * raw), so a straight camera capture would be rejected for no reason the user
 * can act on. Scaling the longest edge to 2048 px keeps A4 text legible (the
 * provider rescales to roughly 1568 px anyway) and lands a photo at a few
 * hundred kilobytes.
 */

/** Longest side, in pixels, after downscaling. */
export const PHOTO_MAX_EDGE_PX = 2048;
/** Above this many bytes a photo is re-encoded even if its edges are small. */
export const PHOTO_MAX_BYTES = 4 * 1024 * 1024;
/** JPEG quality used for the re-encode. */
export const PHOTO_JPEG_QUALITY = 0.85;

/**
 * The target width/height for an image of `width` x `height` so that its
 * longest edge is at most `maxEdge`. Aspect ratio is kept (each side rounded,
 * never below 1 px) and the image is never scaled up. Non-finite or
 * non-positive input comes back as 1 x 1 rather than NaN, so a broken decode
 * cannot reach the canvas as a zero-sized surface.
 */
export function targetSize(
  width: number,
  height: number,
  maxEdge: number = PHOTO_MAX_EDGE_PX,
): { width: number; height: number } {
  if (!(width > 0) || !(height > 0) || !Number.isFinite(width) || !Number.isFinite(height)) {
    return { width: 1, height: 1 };
  }
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width: Math.round(width), height: Math.round(height) };
  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * True when the photo needs work, i.e. it is above `PHOTO_MAX_BYTES` or its
 * longest edge is above `PHOTO_MAX_EDGE_PX`; false when it can go through
 * untouched.
 */
export function needsDownscale(sizeBytes: number, width: number, height: number): boolean {
  return sizeBytes > PHOTO_MAX_BYTES || Math.max(width, height) > PHOTO_MAX_EDGE_PX;
}

/** `IMG_0042.HEIC` -> `IMG_0042.jpg`; a name with no usable base becomes `photo.jpg`. */
function jpegName(original: string): string {
  const base = original.replace(/\.[^./\\]*$/, '').trim();
  return `${base.length > 0 ? base : 'photo'}.jpg`;
}

/** Promise wrapper over `canvas.toBlob`; resolves null when the browser cannot encode. */
function canvasToJpeg(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob), 'image/jpeg', PHOTO_JPEG_QUALITY);
    } catch {
      resolve(null);
    }
  });
}

/**
 * Decodes `file` with `createImageBitmap` (honouring the EXIF orientation, so
 * a portrait photo is not stored sideways), downsizes it on a canvas when it
 * is too big, and re-encodes it as JPEG. Returns a new `File` named
 * `<basename>.jpg` with mime `image/jpeg`.
 *
 * Returns the ORIGINAL file untouched when no work is needed, when the file
 * is not an image, or when anything goes wrong (a HEIC the browser cannot
 * decode, no canvas, an encode failure, a result that is not smaller). In
 * every such case the server's own checks decide what happens next, exactly
 * as for a file picked with the paperclip. Never throws.
 */
export async function preparePhoto(file: File): Promise<File> {
  try {
    if (!file.type.startsWith('image/')) return file;
    if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return file;

    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    try {
      if (!needsDownscale(file.size, bitmap.width, bitmap.height)) return file;

      const size = targetSize(bitmap.width, bitmap.height);
      const canvas = document.createElement('canvas');
      canvas.width = size.width;
      canvas.height = size.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return file;
      // JPEG has no alpha: paint white first so a transparent PNG does not
      // turn black.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, size.width, size.height);
      ctx.drawImage(bitmap, 0, 0, size.width, size.height);

      const blob = await canvasToJpeg(canvas);
      if (!blob || blob.size === 0) return file;
      const resized = size.width !== bitmap.width || size.height !== bitmap.height;
      if (!resized && blob.size >= file.size) return file;

      return new File([blob], jpegName(file.name), {
        type: 'image/jpeg',
        lastModified: file.lastModified,
      });
    } finally {
      bitmap.close();
    }
  } catch {
    return file;
  }
}
