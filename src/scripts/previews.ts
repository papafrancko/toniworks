/**
 * Homepage previews. A card plays its WHOLE film (the 1280 files, never a
 * clip), from 0:00 and looping, over its poster (frame 0 of the film):
 *
 * - hover mode, (hover: hover) and (pointer: fine): while the pointer is on the card;
 * - in-view mode, everything else: the most visible film at >= 60 % in view,
 *   held until it drops below 30 %. Equally visible films (row-mates in a
 *   two-column grid) take turns, one whole play-through each.
 *
 * One film plays at a time. The video layer fades in (CSS, --fade-preview)
 * only once a frame is presented, and fades out (sound ramped down with it)
 * before the video is paused and rewound. Keyboard focus on a card's sound
 * button previews that card. `lyd til` unmutes the playing card and makes the
 * next previews try sound as well. Reduced motion: posters only.
 *
 * The videos ship with preload="none", so they don't compete with fonts and
 * posters while the page loads. Once it has loaded, hover mode lets the films
 * in view fetch their start (preload="metadata"), so a hover starts at once;
 * in-view mode loads a film when it plays.
 */

const hoverQuery = matchMedia('(hover: hover) and (pointer: fine)');
const reducedQuery = matchMedia('(prefers-reduced-motion: reduce)');

const START_RATIO = 0.6;
const STOP_RATIO = 0.3;
/** Films this close to the most visible one count as equally visible. */
const TIE = 0.05;

interface Card {
  root: HTMLElement;
  media: HTMLElement;
  video: HTMLVideoElement;
  button: HTMLButtonElement | null;
  title: string;
  hovered: boolean;
  /** Keyboard focus on the sound button. */
  focused: boolean;
  /** Visible share of the film, from the IntersectionObserver. */
  ratio: number;
  failed: boolean;
  shown: boolean;
  /** performance.now() of the last start; 0 = never. In-view mode's turn order. */
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
/** The page has loaded: hover mode may fetch the start of the films in view. */
let loaded = false;

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

/**
 * In-view mode's pick: the most visible film at >= 60 %, held until it drops
 * below 30 % or another film is clearly more visible. Equally visible films
 * take turns: when the playing one has looped back to 0:00 (`wrapped`), the
 * one that has waited longest takes over, so a film is never cut off mid-way.
 */
function updateInView(wrapped: Card | null = null) {
  const ready = cards.filter((card) => !card.failed && card.ratio >= START_RATIO);
  const top = Math.max(0, ...ready.map((card) => card.ratio));
  const tied = ready.filter((card) => card.ratio >= top - TIE);
  const current = inView && !inView.failed && inView.ratio >= STOP_RATIO ? inView : null;
  const turnOver = current !== null && current === wrapped && tied.some((card) => card !== current);
  if (current && current.ratio >= top - TIE && !turnOver) return;
  // Longest since it last played (never played first), then page order.
  let next: Card | null = null;
  for (const card of tied) {
    if (card !== current && (!next || card.lastStarted < next.lastStarted)) next = card;
  }
  inView = next;
}

function pick(): Card | null {
  if (reducedQuery.matches || document.hidden) return null;
  const focused = cards.find((card) => card.focused && !card.failed);
  if (focused) return focused;
  if (requested && !requested.failed) return requested;
  if (hoverQuery.matches) return cards.find((card) => card.hovered && !card.failed) ?? null;
  return inView;
}

/** Hover mode, once the page has loaded: the films in view fetch their start. */
function warm() {
  if (!loaded || !hoverQuery.matches) return;
  for (const card of cards) {
    if (card.ratio > 0 && card.video.preload === 'none') card.video.preload = 'metadata';
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

function fail(card: Card) {
  card.failed = true;
  if (card.button) card.button.hidden = true;
  updateInView();
  sync();
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

  // A looping film seeks back to 0:00 at its end: in in-view mode an equally
  // visible film may take its turn now.
  video.addEventListener('seeked', () => {
    if (card !== active || card !== inView || hoverQuery.matches || video.currentTime > 0.5) return;
    updateInView(card);
    sync();
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
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const card = cards.find((c) => c.media === entry.target);
        if (card) card.ratio = entry.isIntersecting ? entry.intersectionRatio : 0;
      }
      if (requested && requested.ratio < STOP_RATIO) requested = null;
      updateInView();
      sync();
      warm();
    },
    { threshold: Array.from({ length: 21 }, (_, i) => i / 20) },
  );
  for (const card of cards) observer.observe(card.media);

  hoverQuery.addEventListener('change', () => {
    sync();
    warm();
  });

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
    updateInView();
    sync();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && active) {
      stop(active, true);
      active = null;
    }
    sync();
  });

  // Leaving (or entering the back/forward cache): stop everything at once.
  addEventListener('pagehide', () => {
    for (const card of cards) stop(card, true);
    active = null;
  });
  addEventListener('pageshow', (event) => {
    if (!event.persisted) return;
    requested = null;
    for (const card of cards) {
      card.hovered = false;
      card.focused = card.button?.matches(':focus-visible') ?? false;
    }
    updateInView();
    sync();
  });
}
