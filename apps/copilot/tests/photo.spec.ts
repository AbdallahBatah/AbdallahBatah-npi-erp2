import {
  PHOTO_JPEG_QUALITY,
  PHOTO_MAX_BYTES,
  PHOTO_MAX_EDGE_PX,
  needsDownscale,
  targetSize,
} from '@/components/chat/photo';

// Jest runs in Node (no DOM), so only the pure helpers are covered here;
// `preparePhoto` itself is exercised by e2e/mobile.spec.ts in a real browser.

describe('photo constants', () => {
  it('match the limits the upload and vision paths impose', () => {
    expect(PHOTO_MAX_EDGE_PX).toBe(2048);
    expect(PHOTO_MAX_BYTES).toBe(4 * 1024 * 1024);
    // Well under the 10 MB upload cap and the ~7.5 MB raw vision cap.
    expect(PHOTO_MAX_BYTES).toBeLessThan(7.5 * 1024 * 1024);
    expect(PHOTO_JPEG_QUALITY).toBeGreaterThan(0.5);
    expect(PHOTO_JPEG_QUALITY).toBeLessThanOrEqual(1);
  });
});

describe('targetSize', () => {
  it('scales a 48 MP landscape photo to a 2048 px longest edge, keeping the ratio', () => {
    expect(targetSize(8000, 6000)).toEqual({ width: 2048, height: 1536 });
  });

  it('scales a portrait photo on its height', () => {
    expect(targetSize(3000, 4000)).toEqual({ width: 1536, height: 2048 });
  });

  it('never upscales and leaves a small image as it is', () => {
    expect(targetSize(640, 480)).toEqual({ width: 640, height: 480 });
    expect(targetSize(2048, 2048)).toEqual({ width: 2048, height: 2048 });
  });

  it('honours a custom maximum edge', () => {
    expect(targetSize(4000, 3000, 1000)).toEqual({ width: 1000, height: 750 });
  });

  it('keeps both sides at least 1 px for an extreme aspect ratio', () => {
    expect(targetSize(40000, 10)).toEqual({ width: 2048, height: 1 });
  });

  it('turns broken input into 1 x 1 instead of NaN or zero', () => {
    expect(targetSize(0, 100)).toEqual({ width: 1, height: 1 });
    expect(targetSize(-5, 100)).toEqual({ width: 1, height: 1 });
    expect(targetSize(Number.NaN, 100)).toEqual({ width: 1, height: 1 });
    expect(targetSize(Number.POSITIVE_INFINITY, 100)).toEqual({ width: 1, height: 1 });
  });
});

describe('needsDownscale', () => {
  it('is false for a small file with small edges', () => {
    expect(needsDownscale(300_000, 1280, 960)).toBe(false);
  });

  it('is false exactly at both limits', () => {
    expect(needsDownscale(PHOTO_MAX_BYTES, PHOTO_MAX_EDGE_PX, 1000)).toBe(false);
  });

  it('is true when the file is heavy even with small edges', () => {
    expect(needsDownscale(PHOTO_MAX_BYTES + 1, 1280, 960)).toBe(true);
  });

  it('is true when either edge exceeds the maximum, even for a light file', () => {
    expect(needsDownscale(500_000, PHOTO_MAX_EDGE_PX + 1, 100)).toBe(true);
    expect(needsDownscale(500_000, 100, PHOTO_MAX_EDGE_PX + 1)).toBe(true);
  });
});
