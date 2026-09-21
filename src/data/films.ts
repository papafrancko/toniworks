import type { ImageMetadata } from 'astro';
import { isMap, isScalar, isSeq } from 'yaml';
import filmList from '../content/film.yaml?raw';
import manifest from './media-manifest.json';
import { ContentFile } from './content-file';

/**
 * The films, read at build time from src/content/film.yaml: the owners edit
 * that file on GitHub (order, titles, client, `skjult: true` to hide one).
 * Order there is the order on the homepage and the order "næste film" walks
 * through (wrapping from last to first). Hidden films get no page at all.
 *
 * Everything else comes from the media: src/assets/films/<slug>/ and
 * src/data/media-manifest.json, both written by scripts/encode-media.mjs.
 * The films are never cut, trimmed or re-edited — every file is the whole
 * film, same framing, same sound; only the format and pixel size change:
 *
 *   full-2048.av1.mp4 / .h264.mp4    2048x1340, large screens (film page)
 *   full-1280.av1.mp4 / .h264.mp4    1280x838, small screens + homepage cards
 *   poster.jpg                       frame 0 of the film (poster everywhere)
 *
 * A listed film without its media, a typo in film.yaml or a broken manifest
 * entry fails the build with a Danish message (see content-file.ts).
 */

interface FilmEntry {
  /** URL and media folder name: /film/<slug>, src/assets/films/<slug>/. */
  slug: string;
  /** Title as written in film.yaml (no text-transform). */
  title: string;
  /** Client as written in the credit line ("Produceret for SALTY …"). */
  client: string;
  /** Whole seconds (manifest duration, rounded): "salty · 18 sek." and the player's total. */
  durationSeconds: number;
  /**
   * Flat rgba(10,13,20,0.45) band behind the film-page player controls, for
   * films whose bottom is too bright for white 13 px text. Measured by
   * scripts/encode-media.mjs: manifest films[slug].controlsScrim.
   */
  controlsScrim: boolean;
}

// ------------------------------------------------------------ film.yaml

const FILE = 'src/content/film.yaml';
const FIELDS = ['slug', 'titel', 'kunde', 'skjult'] as const;
const SLUG = /^[a-z0-9-]+$/;
const ADD_FORM = 'tilføj den med formularen "Tilføj film" på GitHub';

interface Listed {
  slug: string;
  title: string;
  client: string;
  hidden: boolean;
  /** For line numbers in messages. */
  node: unknown;
}

const file = new ContentFile(FILE, filmList);

function readList(): Listed[] {
  const root = file.doc.contents;
  if (root === null || (isScalar(root) && String(root.value ?? '').trim() === '')) {
    file.problem(
      null,
      'Filen er tom. Der skal stå mindst én film. Vil I skjule alle film, så skriv "skjult: true" ved hver af dem.',
    );
    return [];
  }
  if (!isSeq(root)) {
    file.problem(
      root,
      'filen skal være en liste over film, hvor hver film starter med "- slug:" (se eksemplerne i filen).',
    );
    return [];
  }

  const listed: Listed[] = [];
  const firstLine = new Map<string, number | undefined>();
  for (const item of root.items) {
    const named: unknown = isMap(item) ? item.get('slug') : undefined;
    const fields = file.fields(
      item,
      FIELDS,
      typeof named === 'string' && named.trim() ? `ved filmen "${named.trim()}"` : 'ved en film',
    );
    if (!fields) {
      file.problem(
        item as { range?: unknown },
        'hver film skal være en blok, der starter med "- slug:" og har "titel:" og "kunde:" på linjerne under, rykket to mellemrum ind.',
      );
      continue;
    }
    const slugPair = fields.get('slug');
    const slug = file.text(slugPair, '"slug"');
    const name = slug ? `filmen "${slug}"` : 'filmen';
    const at = file.at(slugPair) ?? (item as { range?: unknown });

    if (slug === undefined && !slugPair) {
      file.problem(item as { range?: unknown }, 'filmen mangler "slug:" (adressen, fx loeb).');
    } else if (slug === '') {
      file.problem(at, 'filmen mangler en slug efter "slug:" (adressen, fx loeb).');
    } else if (slug !== undefined) {
      if (!SLUG.test(slug)) {
        file.problem(
          at,
          `slug "${slug}" må kun have små bogstaver a-z, tal og bindestreg (ikke æ, ø, å eller mellemrum), fx loeb.`,
        );
      }
      if (firstLine.has(slug)) {
        const first = firstLine.get(slug);
        file.problem(
          at,
          `slug "${slug}" står der to gange${first ? ` (også i linje ${first})` : ''}. Hver film skal have sin egen slug.`,
        );
      } else {
        firstLine.set(slug, file.line(at));
      }
    }

    const required = (field: 'titel' | 'kunde', example: string) => {
      const pair = fields.get(field);
      const value = file.text(pair, `"${field}" ved ${name}`);
      if (!pair) file.problem(at, `${name} mangler "${field}:" (${example}).`);
      else if (value === '') file.problem(file.at(pair), `${name} mangler en tekst efter "${field}:" (${example}).`);
      return value ?? '';
    };
    const title = required('titel', 'titlen på siden');
    const client = required('kunde', 'fx SALTY');

    let hidden = false;
    const hiddenPair = fields.get('skjult');
    const hiddenValue = file.text(hiddenPair, `"skjult" ved ${name}`)?.toLowerCase();
    if (hiddenValue === 'true' || hiddenValue === 'ja') hidden = true;
    else if (hiddenValue !== undefined && !['', 'false', 'nej'].includes(hiddenValue)) {
      file.problem(file.at(hiddenPair), `"skjult" ved ${name} skal være true (eller slet linjen for at vise filmen).`);
    }

    if (slug) listed.push({ slug, title, client, hidden, node: at });
  }
  return listed;
}

const listed = readList();
file.stopIfProblems();

// ------------------------------------------------------------ media

const videos = import.meta.glob<string>('../assets/films/*/*.mp4', {
  eager: true,
  import: 'default',
});
const images = import.meta.glob<ImageMetadata>('../assets/films/*/*.jpg', {
  eager: true,
  import: 'default',
});

const video = (slug: string, name: string) => videos[`../assets/films/${slug}/${name}`];
const image = (slug: string, name: string) => images[`../assets/films/${slug}/${name}`];

const MEDIA_FILES = [
  'full-2048.av1.mp4',
  'full-2048.h264.mp4',
  'full-1280.av1.mp4',
  'full-1280.h264.mp4',
  'poster.jpg',
] as const;

/** The parts of the manifest read here; it holds more (sizes, frame counts, measurements). */
interface ManifestFilm {
  /** The media script's decision (same value as controls.recommendScrim). */
  controlsScrim?: boolean;
  master?: { durationSec?: number };
  files?: Record<string, { durationSec?: number; codecsString?: string } | undefined>;
  controls?: {
    recommendScrim?: boolean;
    regions?: Record<string, { p75?: { secondsBelowAA?: number } } | undefined>;
  };
}
const media: Record<string, ManifestFilm | undefined> =
  (manifest as unknown as { films?: Record<string, ManifestFilm | undefined> }).films ?? {};
const manifestEntry = (slug: string) => (Object.hasOwn(media, slug) ? media[slug] : undefined);

/** `<source type>` value with the file's exact RFC 6381 codecs, plain video/mp4 if unknown. */
const sourceType = (slug: string, name: string) => {
  const codecs = manifestEntry(slug)?.files?.[name]?.codecsString;
  return codecs ? `video/mp4; codecs="${codecs}"` : 'video/mp4';
};

/**
 * The media script's decision: films[slug].controlsScrim (also written as
 * controls.recommendScrim). If a manifest entry ever lacks both booleans,
 * the same rule is applied to its measurements: scrim when any text or glyph
 * box (the regions other than the 'strip-' ones) has a p75 background
 * contrast below its AA level (4.5:1 text, 3:1 glyph; secondsBelowAA counts
 * against it) for more than 0.5 s.
 */
const controlsScrim = (entry: ManifestFilm | undefined): boolean => {
  if (typeof entry?.controlsScrim === 'boolean') return entry.controlsScrim;
  const controls = entry?.controls;
  if (typeof controls?.recommendScrim === 'boolean') return controls.recommendScrim;
  return Object.entries(controls?.regions ?? {}).some(
    ([region, stats]) => !region.startsWith('strip-') && (stats?.p75?.secondsBelowAA ?? 0) > 0.5,
  );
};

const visible = listed.filter((film) => !film.hidden);

// Folders with media that film.yaml doesn't list: the likely reason when a
// listed slug has none (it was renamed).
const listedSlugs = new Set(listed.map((film) => film.slug));
const unlisted = [
  ...new Set(Object.keys({ ...videos, ...images }).map((key) => key.split('/')[3] ?? '')),
].filter((slug) => slug && !listedSlugs.has(slug));
const renameHint = unlisted.length
  ? ` Har I rettet en slug? Der er videofiler til ${unlisted.map((slug) => `"${slug}"`).join(', ')}, som ikke står i filen.`
  : '';

const entries: FilmEntry[] = visible.map(({ slug, title, client, node }) => {
  const at = node as { range?: unknown };
  const missing = MEDIA_FILES.filter((name) =>
    name.endsWith('.jpg') ? !image(slug, name) : !video(slug, name),
  );
  const entry = manifestEntry(slug);
  const seconds = entry?.master?.durationSec ?? entry?.files?.['full-2048.h264.mp4']?.durationSec;

  // One message per film: the form that adds the media also writes the manifest.
  if (missing.length > 0) {
    const which = missing.length < MEDIA_FILES.length ? ` (mangler: ${missing.join(', ')})` : '';
    file.problem(at, `filmen "${slug}" mangler videofiler i src/assets/films/${slug}${which} — ${ADD_FORM}.${renameHint}`);
  } else if (!entry) {
    file.problem(at, `filmen "${slug}" står ikke i src/data/media-manifest.json — ${ADD_FORM}.`);
  } else if (typeof seconds !== 'number' || !(seconds > 0)) {
    file.problem(at, `filmen "${slug}" mangler sin længde i src/data/media-manifest.json — ${ADD_FORM}.`);
  }

  return {
    slug,
    title,
    client,
    durationSeconds: Math.round(seconds ?? 0),
    controlsScrim: controlsScrim(entry),
  };
});
file.stopIfProblems();

// ------------------------------------------------------------ public API

export interface Film extends FilmEntry {
  full: {
    av1?: string;
    h264?: string;
    av1Small?: string;
    h264Small?: string;
    poster?: ImageMetadata;
    /** Ready-made `type` attributes for the four sources above, e.g. video/mp4; codecs="av01.0.12M.10, mp4a.40.2". */
    types: {
      av1: string;
      h264: string;
      av1Small: string;
      h264Small: string;
    };
  };
}

/** The visible films, in film.yaml order. */
export const films: Film[] = entries.map((entry) => ({
  ...entry,
  full: {
    av1: video(entry.slug, 'full-2048.av1.mp4'),
    h264: video(entry.slug, 'full-2048.h264.mp4'),
    av1Small: video(entry.slug, 'full-1280.av1.mp4'),
    h264Small: video(entry.slug, 'full-1280.h264.mp4'),
    poster: image(entry.slug, 'poster.jpg'),
    types: {
      av1: sourceType(entry.slug, 'full-2048.av1.mp4'),
      h264: sourceType(entry.slug, 'full-2048.h264.mp4'),
      av1Small: sourceType(entry.slug, 'full-1280.av1.mp4'),
      h264Small: sourceType(entry.slug, 'full-1280.h264.mp4'),
    },
  },
}));

/** "salty · 18 sek." — client lowercased in content, never via CSS. */
export const filmMeta = (film: Film) =>
  `${film.client.toLowerCase()} · ${film.durationSeconds} sek.`;

export const nextFilm = (film: Film): Film | undefined => {
  if (films.length < 2) return undefined;
  const index = films.findIndex((f) => f.slug === film.slug);
  return films[(index + 1) % films.length];
};
