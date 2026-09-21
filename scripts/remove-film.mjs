#!/usr/bin/env node
/**
 * Removes a film from the site. Run by the GitHub workflow "Fjern film"
 * (.github/workflows/fjern-film.yml); works locally too:
 *
 *   node scripts/remove-film.mjs --slug <slug>
 *
 * Removes the film's block from src/content/film.yaml (every other line,
 * comment and blank line untouched), deletes src/assets/films/<slug>/ and the
 * film's entry in src/data/media-manifest.json. Refuses a slug it does not
 * know. The files stay in the git history.
 *
 * To only take a film off the site for a while, set `skjult: true` on it in
 * film.yaml instead.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FILM_YAML, FILM_YAML_NAME, ROOT, SLUG_RE, Stop, parseFilms, removeFilm } from './film-yaml.mjs';

const OUT = path.join(ROOT, 'src', 'assets', 'films');
const MANIFEST = path.join(ROOT, 'src', 'data', 'media-manifest.json');
const SITE = 'https://www.toniworks.dk';
const ON_GITHUB = Boolean(process.env.GITHUB_ACTIONS);

/** "loeb", " Loeb ", "/film/loeb" and "https://www.toniworks.dk/film/loeb" all mean loeb. */
export function normalizeSlug(input) {
  return String(input ?? '')
    .trim()
    .replace(/^https?:\/\/[^/]+/i, '')
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '')
    .replace(/^.*\/film\//, '')
    .replace(/^\/+/, '')
    .toLowerCase();
}

function parseArgs(argv) {
  const opts = {};
  const keys = new Set(['slug', 'summary-file']);
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([a-z-]+)(?:=(.*))?$/s.exec(argv[i]);
    if (!m || !keys.has(m[1])) throw new Error(`unknown argument ${argv[i]}\nusage: node scripts/remove-film.mjs --slug <slug>`);
    opts[m[1]] = m[2] ?? argv[++i];
  }
  return opts;
}

const md = (s) => String(s).replace(/[\\`*_{}[\]<>|#!]/g, '\\$&');
const escapeData = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

function main() {
  const args = parseArgs(process.argv.slice(2));
  const slug = normalizeSlug(args.slug);
  if (!fs.existsSync(FILM_YAML)) throw new Stop(`${FILM_YAML_NAME} findes ikke.`);
  const text = fs.readFileSync(FILM_YAML, 'utf8');
  const { films } = parseFilms(text);
  const known = films.map((f) => `${f.slug} (${f.titel ?? f.slug})`).join(', ');
  if (!slug) throw new Stop(`Skriv filmens adresse – det, der står efter /film/, fx ${films[0]?.slug ?? 'loeb'}.`);

  const film = films.find((f) => f.slug === slug);
  const dir = path.join(OUT, slug);
  const hasDir = SLUG_RE.test(slug) && fs.existsSync(dir);
  const manifest = fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) : null;
  const inManifest = SLUG_RE.test(slug) && Boolean(manifest?.films && Object.hasOwn(manifest.films, slug));
  if (!film && !hasDir && !inManifest) {
    const byTitle = films.find((f) => String(f.titel ?? '').toLowerCase() === String(args.slug ?? '').trim().toLowerCase());
    throw new Stop(
      `Der er ingen film med adressen "${slug}".` +
        (byTitle ? ` Mente I "${byTitle.slug}" (titlen "${byTitle.titel}")? Brug det, der står efter /film/ i adressen.` : '') +
        (known ? `\nFilmene på listen er: ${known}.` : ''),
    );
  }

  if (film) fs.writeFileSync(FILM_YAML, removeFilm(text, slug));
  if (inManifest) {
    delete manifest.films[slug];
    fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  if (hasDir) fs.rmSync(dir, { recursive: true, force: true });

  const left = films.length - (film ? 1 : 0);
  const visible = films.filter((f) => f.slug !== slug && !f.skjult).length;
  const titel = film?.titel ?? slug;
  const lines = [
    film
      ? `Filmen "${titel}" (${slug}) er fjernet fra ${FILM_YAML_NAME}.`
      : `"${slug}" stod ikke i ${FILM_YAML_NAME}; de efterladte filer er ryddet op.`,
    hasDir ? `Filerne i src/assets/films/${slug}/ er slettet.` : null,
    `${SITE}/film/${slug} virker ikke længere, når Vercel har bygget.`,
    `Der er nu ${left} film på listen${visible !== left ? ` (${visible} vises)` : ''}.`,
    visible === 0 ? 'Der vises ingen film på forsiden nu.' : null,
  ].filter(Boolean);
  console.log(`\n${lines.join('\n')}`);

  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `slug=${slug}\ntitel=${titel}\n`);
  if (args['summary-file']) {
    fs.writeFileSync(
      args['summary-file'],
      [
        `## Filmen er fjernet: ${md(titel)}`,
        '',
        ...lines.slice(1).map(md),
        '',
        'Siden er opdateret om ca. 2 minutter, når Vercel har bygget.',
        '',
        'Filerne ligger stadig i historikken på GitHub. Skal filmen tilbage, så tilføj den igen med "Tilføj film".',
        '',
      ].join('\n'),
    );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    const known = err instanceof Stop;
    console.error(`\nFilmen blev ikke fjernet.\n${known ? err.message : `Uventet fejl: ${err.stack ?? err}`}`);
    const message = known ? err.message : 'Der skete en uventet fejl (se loggen). Send linket til denne kørsel til udvikleren.';
    if (ON_GITHUB) console.log(`::error title=Filmen blev ikke fjernet::${escapeData(message)}`);
    if (process.env.GITHUB_STEP_SUMMARY) {
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Filmen blev ikke fjernet\n\n${md(message)}\n\nIntet er ændret på sitet.\n`);
    }
    process.exitCode = 1;
  }
}
