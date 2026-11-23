// Watches the video of a screen or tab share for new slides. Every tick it draws a tiny greyscale
// thumbnail and compares it (SlideDetector); only when the picture settles on something new is a
// full frame handed on for the model. Frames stay in memory and are dropped once read.
import { SlideDetector, THUMB_H, THUMB_W, toGray } from '../lib/slides';

export const TICK_MS = 2000;
/** Frames sent to the model are scaled down to this width; slide text stays readable. */
const FRAME_W = 1280;

export interface SlideWatcher { stop(): void }

/**
 * A way to grab the current frame. MediaStreamTrackProcessor keeps working while this tab is in the background
 * (the usual case: the user is looking at the meeting); a <video> element is the fallback.
 */
function frameGrabber(track: MediaStreamTrack): { grab(): Promise<ImageBitmap | null>; stop(): void } {
  // The latest frame, owned here (callers must not close it).
  let last: ImageBitmap | null = null;
  const keep = (f: ImageBitmap | null) => { if (f) { last?.close(); last = f; } };
  if (typeof MediaStreamTrackProcessor === 'function') {
    // Read every frame as it arrives and keep only the newest. A still screen sends few or no new
    // frames, so the newest one is simply the picture on screen. (ImageCapture.grabFrame was tried
    // first: it stopped resolving after a few grabs, freezing the picture.)
    const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
    let latest: VideoFrame | null = null;
    let reading = true;
    void (async () => {
      while (reading) {
        const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true as const }));
        if (done || !value) break;
        latest?.close();
        latest = value;
      }
    })();
    return {
      grab: async () => { if (latest) keep(await createImageBitmap(latest)); return last; },
      stop() { reading = false; void reader.cancel().catch(() => {}); latest?.close(); latest = null; last?.close(); last = null; },
    };
  }
  const video = document.createElement('video');
  video.muted = true;
  video.srcObject = new MediaStream([track]);
  void video.play().catch(() => {});
  return {
    grab: async () => { if (video.readyState >= 2 && video.videoWidth) keep(await createImageBitmap(video)); return last; },
    stop() { video.srcObject = null; last?.close(); last = null; },
  };
}

/** Calls `onSlide` with a frame each time a new picture settles on screen, with when it first appeared. */
export function watchSlides(track: MediaStreamTrack, onSlide: (frame: ImageBitmap, at: number) => void, tickMs = TICK_MS): SlideWatcher {
  const grabber = frameGrabber(track);
  const thumb = new OffscreenCanvas(THUMB_W, THUMB_H).getContext('2d', { willReadFrequently: true })!;
  const detector = new SlideDetector();
  let stopped = false;
  let busy = false;

  const tick = async () => {
    if (stopped || busy || track.readyState !== 'live') return;
    busy = true;
    const frame = await grabber.grab();
    try {
      if (!frame || stopped) return;
      thumb.drawImage(frame, 0, 0, THUMB_W, THUMB_H);
      if (detector.push(toGray(thumb.getImageData(0, 0, THUMB_W, THUMB_H).data)) !== 'new') return;
      const scale = Math.min(1, FRAME_W / frame.width);
      // It settled within the last two ticks; the earlier one is closer to when it was first shown.
      onSlide(await createImageBitmap(frame, { resizeWidth: Math.round(frame.width * scale), resizeHeight: Math.round(frame.height * scale), resizeQuality: 'high' }), Date.now() - tickMs);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick().catch(() => {}), tickMs);

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
      grabber.stop();
    },
  };
}
