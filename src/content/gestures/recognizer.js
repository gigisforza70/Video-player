import { createTimerSlot } from '../../lib/time.js';
import { hitTest, isSide, ZONE } from './zones.js';

const HOLD_DELAY_MS = 350;
// How far a drag must travel before the scrub stands up — the same boundary
// for every part of the picture. The move tolerance frees the finger from
// being a tap, but a finger that has gone twelve pixels may still be
// drifting: double-taps wander, palms arrive at an angle, and the scrub's
// whole screen-width sweep turns such wander into minutes of film. Below
// the scrub line the drag simply stays pending, and a lift there is the
// tap the finger meant.
const SCRUB_ENGAGE_PX = 24;
// How long a first tap is followed by the possibility of a second, whether a
// run of side seeks begins there. Nothing waits on it: the tap already spoke,
// so the window only decides whether the next tap joins it as a run.
const MULTI_TAP_WINDOW_MS = 320;
// Once a side is seeking, a tap on it keeps seeking for a little longer than
// the double-tap window: tapping on to go further is a slower rhythm than the
// two taps that started it.
const SEEK_RUN_MS = 700;
const MOVE_TOLERANCE_PX = 12;
// A vertical move must be mostly vertical before it counts as the pull to
// dismiss: a thumb scrubbing along the seek band drifts up and down a
// little, and that drift must never be read as a request the band did not
// make.
const VERTICAL_BIAS = 1.5;
// The right-side vertical gesture can raise the media gain up to 3x. The
// browser's media volume remains capped at 1; gain above that is only applied
// through Web Audio to same-origin media, where routing cannot taint playback.
const MAX_VOLUME_GAIN = 3;
const VOLUME_GESTURE_GAIN_PER_SCREEN = 3;

const isVerticalMove = (dx, dy) => Math.abs(dy) > Math.abs(dx) * VERTICAL_BIAS;

const MODE = {
  IDLE: 'idle',
  PENDING: 'pending',
  DRAG: 'drag',
  HOLD: 'hold',
  PINCH: 'pinch',
  DISMISS: 'dismiss',
  VOLUME: 'volume',
  ABANDONED: 'abandoned',
};

const distanceBetween = (first, second) => {
  const dx = first.x - second.x;
  const dy = first.y - second.y;
  return Math.hypot(dx, dy);
};

export const createRecognizer = (surface, handlers) => {
  const pointers = new Map();

  let mode = MODE.IDLE;
  let anchor = null;
  let tapCount = 0;
  let tapZone = ZONE.MIDDLE;
  let dismissAnchor = null;
  let volumeAnchor = null;
  let lastDismissSample = null;
  let pinchStartDistance = 0;
  let isEnabled = true;
  let audioContext = null;
  let mediaSource = null;
  let gainNode = null;
  let effectiveVolume = null;

  const emit = (name, detail) => {
    const handler = handlers[name];
    if (handler) handler(detail);
  };

  const localPoint = (event) => {
    const rect = surface.getBoundingClientRect();
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
      // The raw pointer too: the overlay's own children live in client
      // coordinates, and a tap on the bar has to land on the bar's map.
      clientX: event.clientX,
      clientY: event.clientY,
      width: rect.width,
      height: rect.height,
    };
  };

  // The hold's moment: armed once per press, cleared by anything that
  // decides the press is not a hold — the pinch, the drift out of the
  // tolerance, the finger's leaving. The fire asks the mode rather than
  // trusting the arm: a fire racing a decision the fingers won has to lose
  // quietly, and a slot that tidies itself the moment its work runs keeps
  // no echo of that bookkeeping behind.
  const holdTimer = createTimerSlot(() => {
    if (mode !== MODE.PENDING) return;
    mode = MODE.HOLD;
    emit('holdStart', { zone: anchor.zone });
  });

  const tapTimer = createTimerSlot(flushTaps);
  function flushTaps() {
    tapCount = 0;
  }

  const volumeToastTimer = createTimerSlot(() => {
    const root = surface.getRootNode();
    root.querySelector?.('.toast')?.classList.remove('is-visible');
  });

  const videoElement = () => {
    const root = surface.getRootNode();
    // The overlay is in the player's shadow root; its host and the video are
    // siblings in the player frame. Keep the recognizer harmless in isolation
    // (including its unit tests) when there is no player host.
    return root.host?.parentElement?.querySelector('video') ?? null;
  };

  const canSafelyBoost = (video) => {
    if (!video.currentSrc) return false;
    try {
      return new URL(video.currentSrc, document.baseURI).origin === location.origin;
    } catch {
      return false;
    }
  };

  const ensureGainGraph = (video) => {
    if (gainNode) return true;
    if (!canSafelyBoost(video)) return false;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return false;
    try {
      audioContext = new AudioContextClass();
      mediaSource = audioContext.createMediaElementSource(video);
      gainNode = audioContext.createGain();
      mediaSource.connect(gainNode);
      gainNode.connect(audioContext.destination);
      video.volume = 1;
      audioContext.resume().catch(() => {});
      return true;
    } catch {
      // If graph setup failed after creating the source node, reconnect it
      // directly so the attempt cannot leave the video silent.
      try {
        mediaSource?.disconnect();
        mediaSource?.connect(audioContext.destination);
      } catch {
        // There is no safe graph to use; retain the media element's native
        // volume rather than claiming that a boost was applied.
      }
      gainNode?.disconnect();
      audioContext?.close().catch(() => {});
      audioContext = null;
      mediaSource = null;
      gainNode = null;
      return false;
    }
  };

  const readVolume = (video) => {
    if (effectiveVolume !== null) return effectiveVolume;
    return Number.isFinite(video.volume) ? video.volume : 1;
  };

  const setVolume = (video, requested) => {
    const level = Math.max(0, Math.min(MAX_VOLUME_GAIN, requested));
    if (level <= 1) {
      try {
        if (gainNode) gainNode.gain.value = 1;
        video.volume = level;
        effectiveVolume = video.volume;
      } catch {
        effectiveVolume = readVolume(video);
      }
      return effectiveVolume;
    }
    if (!ensureGainGraph(video)) {
      // Cross-origin media is deliberately not routed through Web Audio:
      // doing so without CORS approval can mute it. It remains at the
      // browser's native maximum instead.
      video.volume = 1;
      effectiveVolume = 1;
      return effectiveVolume;
    }
    gainNode.gain.value = level;
    video.volume = 1;
    effectiveVolume = level;
    return level;
  };

  const showVolume = (level) => {
    const root = surface.getRootNode();
    const toast = root.querySelector?.('.toast');
    if (!toast) return;
    const percent = Math.round(level * 100);
    toast.textContent = `Volume ${percent}%`;
    toast.classList.add('is-visible');
    volumeToastTimer.set(900);
  };

  const releaseAudioGraph = () => {
    if (mediaSource && audioContext) {
      try {
        mediaSource.disconnect();
        // A MediaElementAudioSourceNode owns the element's output once made.
        // Route it straight to the speakers before releasing our context.
        mediaSource.connect(audioContext.destination);
      } catch {
        // The session's normal media-state restoration remains the fallback.
      }
    }
    gainNode?.disconnect();
    audioContext?.close().catch(() => {});
    audioContext = null;
    mediaSource = null;
    gainNode = null;
    effectiveVolume = null;
  };

  // Every tap speaks the moment the finger lifts: the controls come up under
  // it sooner than any window can allow, and a run of side seeks is paid per
  // tap rather than held to a rhythm the finger did not keep.
  const registerTap = (zone, point) => {
    if (
      tapCount > 0 &&
      isSide(tapZone) &&
      (zone === tapZone || zone === ZONE.MIDDLE)
    ) {
      tapCount += 1;
      emit('multiTap', {
        zone: tapZone,
        count: tapCount,
        x: point.x,
        y: point.y,
      });
      tapTimer.set(SEEK_RUN_MS);
      return;
    }
    tapCount = 1;
    tapZone = zone;
    emit('tap', {
      zone,
      x: point.x,
      y: point.y,
      clientX: point.clientX,
      clientY: point.clientY,
    });
    tapTimer.set(MULTI_TAP_WINDOW_MS);
  };

  const startPinch = () => {
    holdTimer.clear();
    if (mode === MODE.DRAG) emit('dragEnd', { zone: anchor.zone });
    if (mode === MODE.HOLD) emit('holdEnd', { zone: anchor.zone });
    if (mode === MODE.DISMISS) {
      emit('dismissEnd', { progress: 0, velocity: 0 });
      dismissAnchor = null;
      lastDismissSample = null;
    }
    const points = Array.from(pointers.values());
    pinchStartDistance = distanceBetween(points[0], points[1]);
    mode = MODE.PINCH;
    emit('pinchStart', {});
  };

  const handleDown = (event) => {
    if (!isEnabled) return;
    surface.setPointerCapture(event.pointerId);
    const point = localPoint(event);
    pointers.set(event.pointerId, point);

    if (pointers.size === 2) {
      startPinch();
      return;
    }
    if (pointers.size > 2) return;

    anchor = {
      x: point.x,
      y: point.y,
      lastX: point.x,
      lastY: point.y,
      clientX: point.clientX,
      clientY: point.clientY,
      zone: hitTest(point.x, point.width),
    };
    mode = MODE.PENDING;
    holdTimer.set(HOLD_DELAY_MS);
  };

  const handlePinchMove = () => {
    const points = Array.from(pointers.values());
    if (points.length < 2) return;
    const spread = distanceBetween(points[0], points[1]);
    if (pinchStartDistance === 0) return;
    emit('pinchMove', { scale: spread / pinchStartDistance });
  };

  const handleMove = (event) => {
    if (!pointers.has(event.pointerId)) return;
    const point = localPoint(event);
    pointers.set(event.pointerId, point);

    if (mode === MODE.PINCH) {
      handlePinchMove();
      return;
    }
    const isSettled = mode === MODE.ABANDONED || mode === MODE.HOLD;
    if (isSettled) return;

    if (mode === MODE.PENDING) {
      const dx = point.x - anchor.x;
      const dy = point.y - anchor.y;
      if (Math.hypot(dx, dy) < MOVE_TOLERANCE_PX) return;
      holdTimer.clear();
      if (isVerticalMove(dx, dy)) {
        if (anchor.zone === ZONE.RIGHT) {
          mode = MODE.VOLUME;
          const video = videoElement();
          if (video) {
            volumeAnchor = {
              y: anchor.y,
              height: point.height,
              level: readVolume(video),
              video,
            };
          }
        } else if (dy < 0) {
          mode = MODE.ABANDONED;
          return;
        } else {
          mode = MODE.DISMISS;
          dismissAnchor = anchor;
          lastDismissSample = { y: point.y, time: performance.now() };
          emit('dismissStart', {});
          return;
        }
      } else {
        if (Math.hypot(dx, dy) < SCRUB_ENGAGE_PX) return;
        mode = MODE.DRAG;
        emit('dragStart', { zone: anchor.zone, x: anchor.x, y: anchor.y });
      }
    }

    if (mode === MODE.VOLUME) {
      if (volumeAnchor) {
        const change = ((volumeAnchor.y - point.y) / volumeAnchor.height) *
          VOLUME_GESTURE_GAIN_PER_SCREEN;
        const level = setVolume(volumeAnchor.video, volumeAnchor.level + change);
        showVolume(level);
      }
      return;
    }

    if (mode === MODE.DISMISS) {
      emit('dismissMove', {
        progress: (point.y - dismissAnchor.y) / point.height,
      });
      lastDismissSample = { y: point.y, time: performance.now() };
      return;
    }

    if (mode !== MODE.DRAG) return;
    emit('dragMove', {
      zone: anchor.zone,
      dx: point.x - anchor.lastX,
      dy: point.y - anchor.lastY,
      x: point.x,
      y: point.y,
      width: point.width,
      height: point.height,
    });
    anchor.lastX = point.x;
    anchor.lastY = point.y;
  };

  const finishDismiss = (event) => {
    const point = localPoint(event);
    const progress = (point.y - dismissAnchor.y) / point.height;
    let velocity = 0;
    if (lastDismissSample !== null) {
      const slice =
        (point.y - lastDismissSample.y) /
        Math.max(1, performance.now() - lastDismissSample.time);
      velocity = slice > 0 ? (slice * 1000) / point.height : 0;
    }
    emit('dismissEnd', { progress, velocity });
    dismissAnchor = null;
    lastDismissSample = null;
  };

  const handleUp = (event) => {
    if (!pointers.has(event.pointerId)) return;
    const settled = pointers.get(event.pointerId);
    pointers.delete(event.pointerId);

    if (mode === MODE.PINCH) {
      if (pointers.size >= 2) return;
      emit('pinchEnd', {});
      mode = pointers.size === 0 ? MODE.IDLE : MODE.ABANDONED;
      return;
    }
    if (pointers.size > 0) return;

    holdTimer.clear();
    if (mode === MODE.DRAG) emit('dragEnd', { zone: anchor.zone });
    else if (mode === MODE.HOLD) emit('holdEnd', { zone: anchor.zone });
    else if (mode === MODE.DISMISS) finishDismiss(event);
    else if (mode === MODE.PENDING) registerTap(anchor.zone, settled);
    mode = MODE.IDLE;
    volumeAnchor = null;
  };

  const handleCancel = (event) => {
    if (!pointers.has(event.pointerId)) return;
    pointers.delete(event.pointerId);
    holdTimer.clear();
    if (mode === MODE.DRAG) emit('dragEnd', { zone: anchor.zone });
    if (mode === MODE.HOLD) emit('holdEnd', { zone: anchor.zone });
    if (mode === MODE.DISMISS) {
      emit('dismissEnd', { progress: 0, velocity: 0 });
      dismissAnchor = null;
      lastDismissSample = null;
    }
    if (mode === MODE.PINCH && pointers.size < 2) emit('pinchEnd', {});
    if (pointers.size === 0) {
      mode = MODE.IDLE;
      volumeAnchor = null;
    }
  };

  const blockContextMenu = (event) => event.preventDefault();

  surface.addEventListener('contextmenu', blockContextMenu);
  surface.addEventListener('pointerdown', handleDown);
  surface.addEventListener('pointermove', handleMove);
  surface.addEventListener('pointerup', handleUp);
  surface.addEventListener('pointercancel', handleCancel);

  return {
    setEnabled: (value) => {
      isEnabled = value;
    },
    destroy: () => {
      holdTimer.clear();
      tapTimer.clear();
      volumeToastTimer.clear();
      releaseAudioGraph();
      surface.removeEventListener('contextmenu', blockContextMenu);
      surface.removeEventListener('pointerdown', handleDown);
      surface.removeEventListener('pointermove', handleMove);
      surface.removeEventListener('pointerup', handleUp);
      surface.removeEventListener('pointercancel', handleCancel);
    },
  };
};
