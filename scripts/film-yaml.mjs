/**
 * Reads and edits src/content/film.yaml, the film list the owners edit on
 * GitHub, for scripts/add-film.mjs, scripts/remove-film.mjs and
 * scripts/encode-media.mjs.
 *
 * The file is parsed with the yaml Document API (eemeli/yaml). Edits are text
 * splices at the positions the parser reports, so every comment, blank line
 * and column alignment the owners wrote stays byte-for-byte. Every edit is
 * parsed again and compared with the expected list before it is returned.
 *
 * Messages meant for the owners are Danish and thrown as `Stop`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMap, isSeq, parseDocument, stringify } from 'yaml';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FILM_YAML = path.join(ROOT, 'src', 'content', 'film.yaml');
export const FILM_YAML_NAME = 'src/content/film.yaml';
/** What the site accepts as a slug (src/data/films.ts): a-z, 0-9 and dashes. */
export const SLUG_RE = /^[a-z0-9-]+$/;

/** An error whose message is written for the owners (Danish, no stack trace). */
export class Stop extends Error {}

// ---------------------------------------------------------------- parsing

/**
 * Parses film.yaml. Returns the document, the top-level sequence (null when
 * the file holds only comments) and one record per film.
 */
export function parseFilms(text) {
  // Failsafe schema, like the site (src/data/content-file.ts): every value is
  // text, so "slug: 2024" or "titel: 2024" read the same here as on the site.
  const doc = parseDocument(text, { schema: 'failsafe' });
  if (doc.errors.length) {
    const error = doc.errors[0];
    const line = error.linePos?.[0]?.line;
    throw new Stop(
      `${FILM_YAML_NAME} kan ikke læses${line ? ` (linje ${line})` : ''}: ${error.message.split('\n')[0]}\n` +
        'Ret fejlen i filen på GitHub, og prøv igen.',
    );
  }
  const contents = doc.contents;
  if (contents !== null && !isSeq(contents)) {
    throw new Stop(`${FILM_YAML_NAME} skal være en liste, hvor hver film starter med "- slug:".`);
  }
  const films = (contents?.items ?? []).map((item, index) => {
    const slug = isMap(item) ? item.get('slug') : undefined;
    if (typeof slug !== 'string' || !slug) {
      throw new Stop(`Film nr. ${index + 1} i ${FILM_YAML_NAME} mangler "slug:".`);
    }
    const value = (key) => {
      const v = item.get(key);
      return v === undefined || v === null ? undefined : v;
    };
    // Same reading of "skjult" as the site (src/data/films.ts): true or ja.
    const skjult = ['true', 'ja'].includes(String(value('skjult') ?? '').toLowerCase());
    return { slug, titel: value('titel'), kunde: value('kunde'), skjult, node: item };
  });
  return { doc, seq: isSeq(contents) ? contents : null, films };
}

/** The film list, or null when film.yaml does not exist. */
export function readFilms(file = FILM_YAML) {
  if (!fs.existsSync(file)) return null;
  return parseFilms(fs.readFileSync(file, 'utf8')).films;
}

// ---------------------------------------------------------------- lines

/** Splits into lines that keep their own line ending ("\n" or "\r\n"). */
const splitLines = (text) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
const content = (line) => line.replace(/\r?\n$/, '');
const isBlank = (line) => line !== undefined && /^[ \t]*$/.test(content(line));
const isComment = (line) => /^[ \t]*#/.test(line);
const indentOf = (line) => /^[ \t]*/.exec(line)[0].length;

function lineIndex(lines) {
  const starts = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length;
  }
  /** Line number (0-based) that contains a character offset. */
  const lineAt = (pos) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  return { starts, lineAt };
}

/**
 * Line spans of each film block: `start` is the "- " line, `end` the block's
 * last line. Blank lines and comments at the list's own indentation after a
 * block belong to what follows it (the next film or the end of the file), so
 * they are not part of the span; deeper-indented comments are.
 */
function blockSpans(lines, films) {
  const { starts, lineAt } = lineIndex(lines);
  const dashLine = (node) => {
    const at = lineAt(node.range[0]);
    if (/^[ \t]*-([ \t]|$)/.test(lines[at])) return at;
    // "-" alone on its own line, the map below it.
    for (let k = at - 1; k >= 0; k--) {
      if (/^[ \t]*-[ \t]*(#.*)?$/.test(content(lines[k]))) return k;
      if (!isBlank(lines[k]) && !isComment(lines[k])) break;
    }
    return at;
  };
  const startsAt = films.map((film) => dashLine(film.node));
  return films.map((film, i) => {
    const start = startsAt[i];
    const dashIndent = indentOf(lines[start]);
    let end = i + 1 < films.length ? startsAt[i + 1] - 1 : lines.length - 1;
    while (end > start && (isBlank(lines[end]) || (isComment(lines[end]) && indentOf(lines[end]) <= dashIndent))) end--;
    return { start, end, dashIndent, keyColumn: film.node.range[0] - starts[lineAt(film.node.range[0])] };
  });
}

// ---------------------------------------------------------------- editing

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function verify(text, expected, what) {
  const { doc } = parseFilms(text);
  const actual = doc.toJS() ?? [];
  if (!same(actual, expected)) {
    throw new Error(`${what}: the edited film.yaml does not parse to the expected list\n${text}`);
  }
}

/**
 * A single-line YAML scalar, quoted only when YAML needs it. Never a block
 * scalar ("|-"), which yaml picks for "..." or "---" and which can't follow
 * "titel: " on the same line.
 */
const scalar = (value) => stringify(value, { lineWidth: 0, blockQuote: false }).replace(/\n$/, '');

/**
 * Appends a film block at the end of the list, styled like the blocks already
 * there (indentation, blank line between blocks, the "# adressen: …" comment
 * on the slug line).
 */
export function appendFilm(text, film) {
  const { doc, seq, films } = parseFilms(text);
  const lines = splitLines(text);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const spans = blockSpans(lines, films);

  let dashIndent = 0;
  let keyColumn = 2;
  let blankBetween = true;
  let slugComment = null;
  if (films.length) {
    const first = spans[0];
    dashIndent = first.dashIndent;
    keyColumn = first.keyColumn > dashIndent ? first.keyColumn : dashIndent + 2;
    if (films.length > 1) {
      blankBetween = lines.slice(first.end + 1, spans[1].start).some(isBlank);
    } else {
      blankBetween = first.start > 0 && isBlank(lines[first.start - 1]);
    }
    // "- slug: loeb      # adressen: toniworks.dk/film/loeb" -> same comment, same column.
    for (let i = films.length - 1; i >= 0 && !slugComment; i--) {
      const m = /^([ \t]*-[ \t]+slug:[ \t]*)(\S+)([ \t]+)(#.*)$/.exec(content(lines[spans[i].start]));
      if (m && m[4].includes(`/film/${films[i].slug}`)) {
        slugComment = {
          column: m[1].length + m[2].length + m[3].length,
          text: m[4].replace(`/film/${films[i].slug}`, `/film/${film.slug}`),
        };
      }
    }
  }

  const pad = ' '.repeat(keyColumn);
  let slugLine = `${' '.repeat(dashIndent)}-${' '.repeat(keyColumn - dashIndent - 1)}slug: ${scalar(film.slug)}`;
  if (slugComment) slugLine += ' '.repeat(Math.max(2, slugComment.column - slugLine.length)) + slugComment.text;
  const block =
    [slugLine, `${pad}titel: ${scalar(film.titel)}`, `${pad}kunde: ${scalar(film.kunde)}`].join(eol) + eol;

  let out;
  if (seq?.flow) {
    // "[]" (an empty list written inline): replace it with the block.
    if (films.length) throw new Stop(`${FILM_YAML_NAME} er skrevet som [..]-liste. Skriv hver film som en blok, der starter med "- slug:".`);
    const at = lineIndex(lines).lineAt(seq.range[0]);
    if (!/^[ \t]*\[[ \t]*\][ \t]*(#.*)?$/.test(content(lines[at]))) {
      throw new Stop(`${FILM_YAML_NAME}: skriv "[]" på sin egen linje, eller skriv filmene som blokke, der starter med "- slug:".`);
    }
    lines.splice(at, 1, block);
    out = lines.join('');
  } else {
    out = text;
    if (out && !out.endsWith('\n')) out += eol;
    const outLines = splitLines(out);
    if (outLines.length && blankBetween && !isBlank(outLines.at(-1))) out += eol;
    out += block;
  }
  verify(out, [...(doc.toJS() ?? []), { slug: film.slug, titel: film.titel, kunde: film.kunde }], 'appendFilm');
  return out;
}

/**
 * Removes one film's block (its "- slug:" line through its last line) and the
 * blank line it leaves doubled. Comments above the block stay. Removing the
 * last film leaves "[]" so the file still parses as a (empty) list.
 */
export function removeFilm(text, slug) {
  const { doc, films } = parseFilms(text);
  const index = films.findIndex((f) => f.slug === slug);
  if (index < 0) throw new Error(`removeFilm: ${slug} is not in film.yaml`);
  const lines = splitLines(text);
  const span = blockSpans(lines, films)[index];
  const eol = text.includes('\r\n') ? '\r\n' : '\n';

  if (films.length === 1) {
    lines.splice(span.start, span.end - span.start + 1, `${' '.repeat(span.dashIndent)}[]${eol}`);
  } else {
    lines.splice(span.start, span.end - span.start + 1);
    const at = span.start;
    if (at > 0 && isBlank(lines[at - 1]) && (at >= lines.length || isBlank(lines[at]))) {
      lines.splice(at < lines.length ? at : at - 1, 1);
    } else if (at === 0 && isBlank(lines[0])) {
      lines.splice(0, 1);
    }
  }
  const out = lines.join('');
  const expected = (doc.toJS() ?? []).filter((_, i) => i !== index);
  verify(out, expected, 'removeFilm');
  return out;
}
