/**
 * Homepage previews. A card plays its WHOLE film (the 1280 files, never a
 * clip), from 0:00 and looping, over its poster (frame 0 of the film):
 *
 * - hover mode, (hover: hover) and (pointer: fine): while the pointer is on the card;
 * - in-view mode, everything else: the film the viewer has scrolled to, i.e. the
 *   one nearest the middle of the screen among the films far enough in view. It
 *   keeps playing while it stays the middle film, and is cut off — mid-play — as
 *   soon as another film is clearly nearer the middle and has stayed nearest for
 *   a moment, so flicking past a film doesn't start it. Films the same distance
 *   from the middle (row-mates in a two-column grid) take turns, one whole
 *   play-through each.
 *
 * One film plays at a time. The video layer fades in (CSS, --fade-preview)
 * only once a frame is presented, and fades out (sound ramped down with it)
 * before the video is paused and rewound. Keyboard focus on a card's sound
 * button previews that card. `lyd til` unmutes the playing card and makes the
 * next previews try sound as well. Reduced motion: posters only, never loaded.
 *
 * The videos ship with preload="none", so they don't compete with fonts and
 * posters while the page loads. Once it has loaded, hover mode lets the films
 * in view fetch their start (preload="metadata"), so a hover starts at once;
 * in-view mode does the same for the middle film and the one either side of it,
 * so scrolling on to the next film starts it without waiting for the file.
 */

const hoverQuery = matchMedia('(hover: hover) and (pointer: fine)');
const reducedQuery = matchMedia('(prefers-reduced-motion: reduce)');

const START_RATIO = 0.6;
const STOP_RATIO = 0.3;
/** A film filling this much of the screen counts as in view however little of it that is. */
const SCREEN_SHARE = 1 / 3;
/** px nearer the middle of the screen a film must be to take the turn over. */
const CENTRE_MARGIN = 24;
/** ms it must stay the nearest one first, so a flick doesn't start every film it passes. */
const SETTLE_MS = 120;
/** px/s above which the page is still racing past the films: nothing takes over. */
const FLING_SPEED = 1100;
/** ms after the last scroll event at which the page counts as standing still. */
const IDLE_MS = 120;
/** Films either side of the middle one that fetch their start in in-view mode. */
const WARM_REACH = 1;

interface Card {
  root: HTMLElement;
  media: HTMLElement;
  video: HTMLVideoElement;
  button: HTMLButtonElement | null;
  title: string;
  hovered: boolean;
  /** Keyboard focus on the sound button. */
  focused: boolean;
  /** Visible share of the film, measured against the screen. */
  ratio: number;
  /** px from the middle of the film to the middle of the screen. */
  distance: number;
  /** In view enough for in-view mode to pick it. */
  eligible: boolean;
  failed: boolean;
  shown: boolean;
  /** performance.now() of the last start; 0 = never. Turn order among equally near films. */
  lastStarted: number;
  /** Bumped on every start and stop, so a stale play() or frame callback knows it was superseded. */
  run: number;
  resetTimer: number;
  ramp: number;
}

/** --fade-preview in ms, so the pause waits exactly for the CSS fade-out. */
const fadeMs = (() => {
  const value = getComputedStyle(document.documentElement).getPropertyValue('--fade-preview').trim();
  const number = parseFloat(value);
  if (Number.isNaN(number)) return 450;
  return value.endsWith('ms') ? number : number * 1000;
})();

const cards: Card[] = [];
/** The one card that is playing, or about to. */
let active: Card | null = null;
/** In-view mode's pick. */
let inView: Card | null = null;
/**
 * A card whose hidden sound button was pressed while it wasn't previewing
 * (assistive tech and voice control can do that): previewed until the pointer
 * or keyboard focus moves on, or it scrolls out of view.
 */
let requested: Card | null = null;
/** Page-wide, in memory only: set by `lyd til`, cleared by `lyd fra`. */
let soundOn = false;
/** The page has loaded: the films that may play next may fetch their start. */
let loaded = false;
/** In-view mode: the film nearest the middle of the screen, and since when. */
let candidate: Card | null = null;
let candidateAt = 0;
/** Scroll position and speed (px/s) at the last scroll event. */
let scrolledTo = scrollY;
let scrollSpeed = 0;
let scrollAt = 0;
/** requestAnimationFrame and setTimeout handles of a pending re-pick. */
let frame = 0;
let timer = 0;

function setShown(card: Card, shown: boolean) {
  card.shown = shown;
  card.root.classList.toggle('is-previewing', shown);
}

/** Fade in only once a frame is actually on screen, so the poster never fades into navy. */
function showOnNextFrame(card: Card, run: number) {
  const show = () => {
    if (card.run === run) setShown(card, true);
  };
  const { video } = card;
  if ('requestVideoFrameCallback' in video) video.requestVideoFrameCallback(show);
  else requestAnimationFrame(() => requestAnimationFrame(show));
}

function rampVolume(card: Card, to: number) {
  const { video } = card;
  cancelAnimationFrame(card.ramp);
  const from = video.volume;
  const startedAt = performance.now();
  const step = (now: number) => {
    const t = Math.min(1, Math.max(0, (now - startedAt) / fadeMs));
    video.volume = from + (to - from) * t;
    if (t < 1) card.ramp = requestAnimationFrame(step);
  };
  card.ramp = requestAnimationFrame(step);
}

const attempt = (video: HTMLVideoElement) =>
  video.play().then(
    () => null,
    (error: unknown) => error as DOMException,
  );

async function play(card: Card, run: number) {
  const { video } = card;
  let error = await attempt(video);
  if (error?.name === 'NotAllowedError' && !video.muted && card.run === run) {
    // Sound refused without a user gesture: play muted, the button offers `lyd til`.
    video.muted = true;
    error = await attempt(video);
  }
  // Stopped meanwhile (its pause() also rejects a pending play()).
  if (card.run !== run) return;
  if (error) {
    if (error.name === 'NotSupportedError') fail(card);
    // Otherwise autoplay is blocked: the poster stays.
    return;
  }
  showOnNextFrame(card, run);
}

function start(card: Card) {
  const run = ++card.run;
  const { video } = card;
  card.lastStarted = performance.now();
  clearTimeout(card.resetTimer);
  cancelAnimationFrame(card.ramp);
  if (!video.paused) {
    // Back before the fade-out finished: keep playing, bring picture and sound back.
    rampVolume(card, 1);
    showOnNextFrame(card, run);
    return;
  }
  video.muted = !soundOn;
  video.volume = 1;
  void play(card, run);
}

function reset(card: Card) {
  const { video } = card;
  cancelAnimationFrame(card.ramp);
  video.pause();
  if (video.currentTime !== 0) video.currentTime = 0;
  video.muted = true;
  video.volume = 1;
}

/** Fade picture and sound out, then pause and rewind. `now` skips the fade. */
function stop(card: Card, now = false) {
  card.run++;
  clearTimeout(card.resetTimer);
  const wasShown = card.shown;
  setShown(card, false);
  if (!wasShown || now) {
    reset(card);
    return;
  }
  if (!card.video.muted) rampVolume(card, 0);
  card.resetTimer = window.setTimeout(() => reset(card), fadeMs);
}

/** Where every film sits relative to the middle of the screen. */
function measure() {
  const height = innerHeight;
  const middle = height / 2;
  const scrolled = scrollY;
  const scrollable = Math.max(0, document.documentElement.scrollHeight - height);
  // The middle of the screen can only travel this far over the page from here, so
  // a film the page cannot bring to it — the first one while the page is at the
  // top, the last one at the bottom — counts as being there.
  const highest = middle - scrolled;
  const lowest = middle + scrollable - scrolled;
  for (const card of cards) {
    const box = card.media.getBoundingClientRect();
    const visible = Math.max(0, Math.min(height, box.bottom) - Math.max(0, box.top));
    card.ratio = box.height > 0 ? visible / box.height : 0;
    const centre = Math.min(Math.max(box.top + box.height / 2, highest), lowest);
    card.distance = Math.abs(centre - middle);
    // 60 % of the film in view, or a third of the screen filled by it: a film
    // taller than the screen (a phone held sideways) can never reach 60 % of
    // itself, and neither can the two films either side of the titles between them.
    card.eligible =
      !card.failed && (card.ratio >= START_RATIO || visible >= height * SCREEN_SHARE);
  }
}

/** The film nearest the middle of the screen; page order breaks an exact tie. */
function nearest() {
  let best: Card | null = null;
  for (const card of cards) {
    if (card.eligible && (!best || card.distance < best.distance)) best = card;
  }
  return best;
}

/** Among the films as near the middle as `best`: the one that has waited longest. */
function waiting(current: Card, best: Card) {
  let next: Card | null = null;
  for (const card of cards) {
    if (card === current || !card.eligible || card.distance > best.distance + CENTRE_MARGIN) continue;
    if (!next || card.lastStarted < next.lastStarted) next = card;
  }
  return next;
}

/** px/s the page is scrolling right now; 0 once it has stood still for a moment. */
function speed(now: number) {
  return now - scrollAt > IDLE_MS ? 0 : scrollSpeed;
}

/** Re-pick after `delay`: the scroll may have stopped, so no event would do it. */
function later(delay: number) {
  clearTimeout(timer);
  timer = window.setTimeout(() => update(), delay);
}

/**
 * In-view mode's pick: the film nearest the middle of the screen — the one the
 * viewer has scrolled to. It keeps playing while it is still the nearest (within
 * CENTRE_MARGIN, so a few pixels of jitter can't swap it) and at least 30 % in
 * view. Another film takes it over once it is clearly nearer and has been for
 * SETTLE_MS, and never while the page is still racing past (FLING_SPEED), so a
 * flick doesn't start every film on its way. Films the same distance from the
 * middle (row-mates in a two-column grid) take turns instead: when the playing
 * one has looped back to 0:00 (`wrapped`), the one that has waited longest goes.
 */
function updateInView(wrapped: Card | null = null) {
  const now = performance.now();
  const best = nearest();
  const current = inView && !inView.failed && inView.ratio >= STOP_RATIO ? inView : null;
  if (current && (!best || best.distance > current.distance - CENTRE_MARGIN)) {
    // Still the middle film: leave it playing, unless it has looped and an
    // equally near film is waiting for its turn.
    candidate = null;
    inView = (best && current === wrapped ? waiting(current, best) : null) ?? current;
    return;
  }
  // The film that was playing has scrolled away: stop it, even mid-play.
  if (!current) inView = null;
  if (candidate !== best) {
    candidate = best;
    candidateAt = now;
  }
  if (!best) return;
  const held = now - candidateAt;
  const racing = speed(now) > FLING_SPEED;
  if (racing || held < SETTLE_MS) {
    // Come back when it has held still long enough, or when the page has stopped.
    later(racing ? IDLE_MS + 20 : Math.max(SETTLE_MS - held, 20));
    return;
  }
  inView = best;
}

function pick(): Card | null {
  if (reducedQuery.matches || document.hidden) return null;
  const focused = cards.find((card) => card.focused && !card.failed);
  if (focused) return focused;
  if (requested && !requested.failed) return requested;
  if (hoverQuery.matches) return cards.find((card) => card.hovered && !card.failed) ?? null;
  return inView;
}

/** Once the page has loaded: the films that may play next fetch their start. */
function warm() {
  if (!loaded || reducedQuery.matches) return;
  if (hoverQuery.matches) {
    // Hover mode: every film in view, so a hover starts at once.
    for (const card of cards) {
      if (card.ratio > 0 && card.video.preload === 'none') card.video.preload = 'metadata';
    }
    return;
  }
  // In-view mode: the middle film and the one either side of it, so scrolling on
  // starts the next film at once without pulling every film over mobile data.
  // Not while the page is racing past them, or a flick would fetch the lot.
  if (speed(performance.now()) > FLING_SPEED) return;
  let middle = -1;
  let least = Infinity;
  for (let i = 0; i < cards.length; i++) {
    const card = cards[i];
    if (card.failed || card.distance >= least) continue;
    least = card.distance;
    middle = i;
  }
  if (middle < 0) return;
  const from = Math.max(0, middle - WARM_REACH);
  const to = Math.min(cards.length - 1, middle + WARM_REACH);
  for (let i = from; i <= to; i++) {
    const { video } = cards[i];
    if (video.preload === 'none') video.preload = 'metadata';
  }
}

/** Starting one card stops the other first. */
function sync() {
  const next = pick();
  if (next === active) return;
  if (active) stop(active);
  active = next;
  if (next) start(next);
}

/** Measure the films against the screen, re-pick, act. */
function update(wrapped: Card | null = null) {
  clearTimeout(timer);
  measure();
  if (requested && requested.ratio < STOP_RATIO) requested = null;
  updateInView(wrapped);
  sync();
  warm();
}

/** At most one update per frame, however many scroll or observer events arrive. */
function refresh() {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    update();
  });
}

function fail(card: Card) {
  card.failed = true;
  if (card.button) card.button.hidden = true;
  update();
}

function label(card: Card) {
  const { button, video } = card;
  const action = video.muted ? 'til' : 'fra';
  if (!button || button.dataset.action === action) return;
  button.dataset.action = action;
  button.textContent = `lyd ${action}`;
  button.setAttribute('aria-label', `Slå lyd ${action} for ${card.title}`);
}

function toggleSound(card: Card) {
  const { video } = card;
  // What the label offered when it was pressed.
  const turnOn = video.muted;
  if (active !== card) {
    // Pressed while not previewing (the button is hidden, but assistive tech
    // and voice control can reach it): preview the card, then act on it.
    requested = card;
    sync();
    if (active !== card) {
      requested = null;
      return;
    }
  }
  if (!turnOn) {
    soundOn = false;
    video.muted = true;
    return;
  }
  soundOn = true;
  cancelAnimationFrame(card.ramp);
  video.volume = 1;
  video.muted = false;
  // Autoplay was blocked and keyboard focus shows the button over the poster: this click may start it.
  if (video.paused && active === card) void play(card, card.run);
}

function setup(root: HTMLElement) {
  const media = root.querySelector<HTMLElement>('.media');
  const video = root.querySelector('video');
  if (!media || !video) return;

  const card: Card = {
    root,
    media,
    video,
    button: root.querySelector<HTMLButtonElement>('button'),
    title: root.dataset.title ?? '',
    hovered: false,
    focused: false,
    ratio: 0,
    distance: Infinity,
    eligible: false,
    failed: false,
    shown: false,
    lastStarted: 0,
    run: 0,
    resetTimer: 0,
    ramp: 0,
  };
  cards.push(card);

  // Touch in hover mode (touch laptops) would start and stop at once: ignore it.
  root.addEventListener('pointerenter', (event) => {
    if (event.pointerType === 'touch') return;
    card.hovered = true;
    requested = null;
    sync();
  });
  root.addEventListener('pointerleave', (event) => {
    if (event.pointerType === 'touch') return;
    card.hovered = false;
    requested = null;
    sync();
  });

  // A looping film seeks back to 0:00 at its end: in in-view mode a film the
  // same distance from the middle of the screen may take its turn now.
  video.addEventListener('seeked', () => {
    if (card !== active || card !== inView || hoverQuery.matches || video.currentTime > 0.5) return;
    update(card);
  });

  video.addEventListener('volumechange', () => label(card));
  video.addEventListener('error', () => fail(card));
  // Every source failed (missing file, no supported codec). Under reduced motion
  // the sources are skipped on purpose, which is not a failure.
  video.querySelector('source:last-of-type')?.addEventListener('error', () => {
    if (!reducedQuery.matches) fail(card);
  });
  if (video.error) card.failed = true;

  const { button } = card;
  if (button) {
    button.hidden = card.failed || reducedQuery.matches;
    label(card);
    button.addEventListener('click', (event) => {
      toggleSound(card);
      // A mouse click leaves no focus behind, so a later Space or Enter can't press it again.
      if (event.detail > 0) button.blur();
    });
    // Keyboard focus previews the card (so the button is on a playing film); a mouse click does not.
    button.addEventListener('focus', () => {
      card.focused = button.matches(':focus-visible');
      requested = null;
      sync();
    });
    button.addEventListener('blur', () => {
      card.focused = false;
      if (requested === card) requested = null;
      sync();
    });
  }
}

document.querySelectorAll<HTMLElement>('[data-film-card]').forEach(setup);

if (cards.length > 0) {
  // Scrolling picks the film in the middle of the screen; the observer catches
  // everything else that moves the films past it — the page opening, a resize, a
  // late layout shift — without a measurement of its own.
  const observer = new IntersectionObserver(() => refresh(), {
    threshold: [0, STOP_RATIO, START_RATIO, 1],
  });
  for (const card of cards) observer.observe(card.media);

  addEventListener(
    'scroll',
    () => {
      const now = performance.now();
      const y = scrollY;
      const since = now - scrollAt;
      if (since > 0) {
        const px = (Math.abs(y - scrolledTo) / since) * 1000;
        // Rises at once and falls over a few frames, so a flick and the momentum
        // after it read as one long gesture rather than a series of short ones.
        scrollSpeed = since > IDLE_MS ? px : Math.max(px, scrollSpeed * 0.7);
      }
      scrolledTo = y;
      scrollAt = now;
      refresh();
    },
    { passive: true },
  );
  addEventListener('resize', () => refresh(), { passive: true });

  hoverQuery.addEventListener('change', () => update());

  const afterLoad = () => {
    const ready = () => {
      loaded = true;
      warm();
    };
    if ('requestIdleCallback' in window) requestIdleCallback(ready, { timeout: 2000 });
    else setTimeout(ready, 200);
  };
  if (document.readyState === 'complete') afterLoad();
  else addEventListener('load', afterLoad, { once: true });

  reducedQuery.addEventListener('change', () => {
    for (const card of cards) {
      // The sources were skipped under reduced motion: select them now.
      if (!reducedQuery.matches && !card.video.currentSrc) {
        card.failed = false;
        card.video.load();
      }
      if (card.button) card.button.hidden = card.failed || reducedQuery.matches;
    }
    update();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (active) stop(active, true);
      active = null;
      return;
    }
    update();
  });

  // Leaving (or entering the back/forward cache): stop everything at once.
  addEventListener('pagehide', () => {
    for (const card of cards) stop(card, true);
    active = null;
  });
  addEventListener('pageshow', (event) => {
    if (!event.persisted) return;
    requested = null;
    candidate = null;
    scrolledTo = scrollY;
    scrollSpeed = 0;
    for (const card of cards) {
      card.hovered = false;
      card.focused = card.button?.matches(':focus-visible') ?? false;
    }
    update();
  });
}
