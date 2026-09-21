/**
 * Film page player: custom controls over a muted, autoplaying <video>.
 * Markup and styles live in src/components/Player.astro; this wires them up
 * and swaps out the native controls the markup ships for no-JS visitors.
 *
 * State lives on the root element so CSS can follow it:
 *   data-state   playing | paused | ended   (glyph: bars while playing, triangle otherwise)
 *   data-idle    controls faded out and cursor hidden (only while playing)
 *   data-frame   the video has a frame to show; until then the poster underneath shows
 *   data-failed  no source could be played; the poster stays, the controls go
 */

const HIDE_AFTER_MS = 3000;
const SEEK_STEP = 5;
/** Paused before this point counts as "not started yet" (seconds). */
const START_WINDOW = 0.5;

/** m:ss, no leading zero on minutes */
const clock = (seconds: number) => {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

type State = 'playing' | 'paused' | 'ended';

export function initPlayer(root: HTMLElement) {
  const video = root.querySelector('video');
  const controls = root.querySelector<HTMLElement>('[data-controls]');
  const toggle = root.querySelector<HTMLButtonElement>('[data-toggle]');
  const sound = root.querySelector<HTMLButtonElement>('[data-sound]');
  const progress = root.querySelector<HTMLElement>('[data-progress]');
  const fill = root.querySelector<HTMLElement>('[data-fill]');
  const time = root.querySelector<HTMLElement>('[data-time]');
  if (!video || !controls || !toggle || !sound || !progress || !fill || !time) return;

  // The markup carries the browser's own controls for visitors without
  // JavaScript. The custom ones take over here, before the video is first
  // shown (it stays transparent until reveal() below), so they never flash.
  video.removeAttribute('controls');

  /** The labelled length (whole seconds from the film data), shown as the total. */
  const total = Number(root.dataset.duration) || 0;
  const totalLabel = clock(total);
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  let hideTimer = 0;
  let raf = 0;
  let dragging = false;
  let started = false;
  let shownSecond = -1;
  let lastPointer = '';
  let idleAtPointerDown = false;
  let lastMouse = { x: -1, y: -1 };

  /** Real media length for seeking and the progress line; the label is only for display. */
  const length = () => (Number.isFinite(video.duration) && video.duration > 0 ? video.duration : total);

  const state = () => root.dataset.state as State;

  const setState = (next: State) => {
    root.dataset.state = next;
    toggle.setAttribute('aria-label', next === 'playing' ? 'Pause' : 'Afspil');
    if (next === 'playing') startTicking();
    reveal();
  };

  // --- Rendering -----------------------------------------------------------

  const render = () => {
    const ended = state() === 'ended';
    const position = ended ? length() : video.currentTime;
    fill.style.transform = `scaleX(${clamp(position / length(), 0, 1)})`;

    // Current time is floored; at the end it shows the labelled total.
    const second = ended ? total : Math.min(Math.floor(position), total);
    if (second !== shownSecond) {
      shownSecond = second;
      time.textContent = `${clock(second)} / ${totalLabel}`;
      progress.setAttribute('aria-valuenow', String(second));
      progress.setAttribute('aria-valuetext', `${clock(second)} af ${totalLabel}`);
    }
  };

  const tick = () => {
    render();
    raf = video.paused ? 0 : requestAnimationFrame(tick);
  };

  const startTicking = () => {
    if (!raf) raf = requestAnimationFrame(tick);
  };

  const renderSound = () => {
    sound.textContent = video.muted ? 'lyd til' : 'lyd fra';
    sound.setAttribute('aria-label', video.muted ? 'Slå lyd til' : 'Slå lyd fra');
  };

  // --- Controls visibility -------------------------------------------------

  /** Keyboard focus inside the controls keeps them up; a mouse-clicked button does not. */
  const keyboardFocusInside = () => {
    const active = document.activeElement;
    return !!active && controls.contains(active) && active.matches(':focus-visible');
  };

  const canHide = () => state() === 'playing' && !dragging && !keyboardFocusInside();

  const hide = () => {
    if (canHide()) root.dataset.idle = '';
  };

  /** Show the controls and restart the 3 s countdown (which only runs while playing). */
  const show = () => {
    delete root.dataset.idle;
    clearTimeout(hideTimer);
    if (canHide()) hideTimer = window.setTimeout(hide, HIDE_AFTER_MS);
  };

  // --- Playback actions ----------------------------------------------------

  const play = () => {
    if (video.ended) video.currentTime = 0;
    video.play().catch(() => {
      // Autoplay or play() refused (e.g. iOS Low Power Mode): stay on the poster/frame.
      if (video.paused) {
        setState(video.ended ? 'ended' : 'paused');
        show();
      }
    });
  };

  const togglePlay = () => {
    if (video.paused || video.ended) play();
    else video.pause();
  };

  /**
   * Sound on. Restarts from 0 if the film has ended, and starts it if it is
   * paused at the very start (autoplay refused, or reduced motion).
   */
  const unmute = () => {
    video.muted = false;
    if (video.ended || (video.paused && video.currentTime < START_WINDOW)) play();
  };

  const toggleMute = () => {
    if (video.muted) unmute();
    else video.muted = true;
  };

  const seekTo = (seconds: number) => {
    video.currentTime = clamp(seconds, 0, length());
    if (state() === 'ended' && !video.ended) setState('paused');
    render();
  };

  // --- Video events --------------------------------------------------------

  /** The poster under the video is frame 0, so the switch is invisible. */
  const reveal = () => {
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) root.dataset.frame = '';
  };

  video.addEventListener('loadeddata', reveal);
  video.addEventListener('seeked', reveal);
  video.addEventListener('play', () => {
    setState('playing');
    show();
  });
  video.addEventListener('playing', () => {
    started = true;
    reveal();
  });
  video.addEventListener('pause', () => {
    if (!video.ended) setState('paused');
    show();
    render();
  });
  video.addEventListener('ended', () => {
    setState('ended');
    show();
    render();
  });
  video.addEventListener('seeked', () => {
    if (video.ended && video.paused) setState('ended');
    else if (state() === 'ended') setState(video.paused ? 'paused' : 'playing');
    render();
  });
  for (const type of ['timeupdate', 'durationchange', 'loadedmetadata']) {
    video.addEventListener(type, render);
  }
  video.addEventListener('volumechange', renderSound);

  // The last <source> failing means nothing could be played: keep the poster.
  const sources = video.querySelectorAll('source');
  sources[sources.length - 1]?.addEventListener('error', () => {
    if (video.networkState === HTMLMediaElement.NETWORK_NO_SOURCE) {
      root.dataset.failed = '';
      clearTimeout(hideTimer);
    }
  });

  // --- Pointer: surface, reveal, progress ----------------------------------

  root.addEventListener('pointerdown', (event) => {
    lastPointer = event.pointerType;
    idleAtPointerDown = root.hasAttribute('data-idle');
  });

  // Only real mouse movement reveals the controls: browsers also send
  // zero-distance moves after layout changes (e.g. when the cursor hides).
  root.addEventListener('pointermove', (event) => {
    if (event.pointerType === 'touch') return;
    if (event.screenX === lastMouse.x && event.screenY === lastMouse.y) return;
    lastMouse = { x: event.screenX, y: event.screenY };
    show();
  });

  root.addEventListener('click', (event) => {
    const target = event.target as Element;
    if (target.closest('button, [role="slider"]')) return;
    // On touch, a tap on hidden controls only brings them back.
    if (lastPointer === 'touch' && idleAtPointerDown) {
      show();
      return;
    }
    if (video.muted) unmute();
    else togglePlay();
    show();
  });

  toggle.addEventListener('click', (event) => {
    togglePlay();
    if (event.detail > 0) toggle.blur();
    show();
  });

  sound.addEventListener('click', (event) => {
    toggleMute();
    if (event.detail > 0) sound.blur();
    show();
  });

  const scrub = (event: PointerEvent) => {
    const box = progress.getBoundingClientRect();
    seekTo(((event.clientX - box.left) / box.width) * length());
  };

  progress.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    dragging = true;
    progress.setPointerCapture(event.pointerId);
    scrub(event);
    show();
  });
  progress.addEventListener('pointermove', (event) => {
    if (dragging) scrub(event);
  });
  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    show();
  };
  progress.addEventListener('pointerup', endDrag);
  progress.addEventListener('pointercancel', endDrag);
  progress.addEventListener('lostpointercapture', endDrag);

  // --- Keyboard ------------------------------------------------------------

  progress.addEventListener('keydown', (event) => {
    let target: number;
    switch (event.key) {
      case 'Home':
        target = 0;
        break;
      case 'End':
        target = length();
        break;
      case 'ArrowUp':
        target = video.currentTime + SEEK_STEP;
        break;
      case 'ArrowDown':
        target = video.currentTime - SEEK_STEP;
        break;
      default:
        return;
    }
    event.preventDefault();
    seekTo(target);
    show();
  });

  // Shortcuts when focus is on the player or nowhere in particular (body).
  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target as Element;
    const onPlayer = root.contains(target);
    if (!onPlayer && target !== document.body && target !== document.documentElement) return;
    if (root.hasAttribute('data-failed')) return;

    switch (event.key) {
      case ' ':
      case 'k':
      case 'K':
        // Space on a focused button presses that button.
        if (event.key === ' ' && target instanceof HTMLButtonElement) return;
        if (!event.repeat) togglePlay();
        break;
      case 'm':
      case 'M':
        if (!event.repeat) toggleMute();
        break;
      case 'ArrowLeft':
        seekTo(video.currentTime - SEEK_STEP);
        break;
      case 'ArrowRight':
        seekTo(video.currentTime + SEEK_STEP);
        break;
      default:
        return;
    }
    event.preventDefault();
    show();
  });

  // Opened in a background tab: some browsers refuse autoplay until the page is seen.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !started && !reducedMotion && video.paused) play();
  });

  controls.addEventListener('focusin', show);
  controls.addEventListener('focusout', () => requestAnimationFrame(show));

  // --- Start ---------------------------------------------------------------

  renderSound();
  if (!video.paused) {
    // Autoplay started before this module ran.
    started = true;
    setState('playing');
  } else if (reducedMotion) {
    // No autoplay (the inline script in Player.astro removed the attribute).
    setState('paused');
  } else {
    // The markup already shows the playing state; play() reports a block.
    play();
  }
  reveal();
  render();
  show();
}
