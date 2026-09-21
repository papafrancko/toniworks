/**
 * Reads one of the files the owners edit on GitHub (src/content/film.yaml,
 * src/content/tekster.yaml) and turns every mistake into a Danish message
 * with a line number. Any problem stops the build: Vercel then keeps the last
 * good version of the site online, and the "Tjek bygning" check on GitHub
 * turns red with the message.
 *
 * YAML is parsed with the failsafe schema, so every value is plain text:
 * `titel: 2024` stays "2024", `cvr: 01234567` keeps its leading zero, and
 * `skjult: true` is read by films.ts itself (it also accepts ja/nej).
 */
import { isMap, isScalar, isSeq, LineCounter, parseDocument, type Document, type Pair } from 'yaml';

type Located = { range?: unknown } | null | undefined;

const SYNTAX_HINTS: Record<string, string> = {
  DUPLICATE_KEY: 'det samme felt står to gange i samme blok. Slet det ene.',
  TAB_AS_INDENT: 'linjen er rykket ind med tabulator. Brug mellemrum i stedet.',
  MISSING_CHAR: 'der mangler et tegn her, ofte et afsluttende anførselstegn.',
  BAD_SCALAR_START:
    'teksten starter med et tegn, der ikke må stå først (fx @, ` eller %). Sæt hele teksten i anførselstegn.',
  MULTIPLE_DOCS: 'der må ikke stå en linje med kun "---" i filen.',
};
/** For `titel: sauna: del 2`: suggest `titel: "sauna: del 2"`. */
const colonHint = (line: string) => {
  const [, key = 'titel', value = 'sauna: del 2'] = line.match(/^[ -]*([^:]+):\s+([^#]*?)\s*(#.*)?$/) ?? [];
  return `der står et kolon (:) inde i teksten. Sæt hele teksten i anførselstegn: ${key}: "${value}"`;
};
const DEFAULT_HINT =
  'filen kan ikke læses her. Tjek at linjen er rykket lige så langt ind som linjerne omkring den, ' +
  'og at der er et mellemrum efter kolon. Står der et kolon (:) inde i en tekst, så sæt teksten i anførselstegn.';

export class ContentFile {
  readonly doc: Document.Parsed;
  private readonly lines = new LineCounter();
  private readonly problems: { line: number; message: string }[] = [];

  constructor(
    /** Path shown in messages, e.g. src/content/film.yaml */
    readonly path: string,
    source: string,
  ) {
    this.doc = parseDocument(source, {
      schema: 'failsafe',
      lineCounter: this.lines,
      prettyErrors: true,
      uniqueKeys: true,
    });
    // Only the first syntax error: the ones after it are usually knock-on errors.
    const error = this.doc.errors[0];
    if (error) {
      const sourceLines = source.split(/\r?\n/);
      let line = error.linePos?.[0]?.line ?? 0;
      if (error.code === 'MISSING_CHAR' && /quote/.test(error.message)) {
        // Reported where the file ends; point at the line whose quote never closes.
        const open = sourceLines.findIndex((l, i) => {
          const quoted = !l.trimStart().startsWith('#') && l.match(/:\s+(["'])(.*)$/);
          return i < line && quoted && !quoted[2].includes(quoted[1]);
        });
        if (open >= 0) line = open + 1;
      }
      const text = sourceLines[line - 1] ?? '';
      const technical = error.message.split(/ at line \d+/)[0];
      const hint = /^[ -]*\t/.test(text)
        ? SYNTAX_HINTS.TAB_AS_INDENT
        : error.code !== 'DUPLICATE_KEY' && /^[ -]*[^\s:#'"][^:#]*:\s+[^\s'">|#][^#]*:(\s|$)/.test(text)
          ? colonHint(text)
          : (SYNTAX_HINTS[error.code] ?? DEFAULT_HINT);
      this.problems.push({ line, message: `${hint} (YAML: ${technical})` });
      // Until the syntax is right the structure can't be trusted.
      this.stopIfProblems();
    }
  }

  /** 1-based line where a YAML node starts. */
  line(node: Located): number | undefined {
    const range = node?.range;
    return Array.isArray(range) && typeof range[0] === 'number'
      ? this.lines.linePos(range[0]).line
      : undefined;
  }

  /** Record a problem; everything is reported together by stopIfProblems(). */
  problem(node: Located, message: string) {
    this.problems.push({ line: this.line(node) ?? 0, message });
  }

  /** Fails the build with every problem found so far, in line order. */
  stopIfProblems() {
    if (this.problems.length === 0) return;
    const sorted = [...this.problems].sort((a, b) => a.line - b.line);
    throw new Error(
      [
        `Fejl i ${this.path}:`,
        '',
        ...sorted.map(({ line, message }) => `  • ${line ? `Linje ${line}: ` : ''}${message}`),
        '',
        'Hjemmesiden bliver ikke opdateret, før det er rettet. Den nuværende version af siden er stadig online.',
      ].join('\n'),
    );
  }

  /**
   * The fields of one block (a YAML mapping), by name. Unknown field names are
   * reported (they are usually typos, like "titl"); `where` says which block,
   * e.g. `ved filmen "loeb"` or `under "kontakt"`.
   */
  fields(node: unknown, allowed: readonly string[], where: string): Map<string, Pair> | undefined {
    if (!isMap(node)) return undefined;
    const fields = new Map<string, Pair>();
    for (const pair of node.items) {
      const name = isScalar(pair.key) ? String(pair.key.value ?? '').trim() : '';
      if (allowed.includes(name)) {
        fields.set(name, pair);
      } else {
        this.problem(
          pair.key as Located,
          `ukendt felt "${name}" ${where}. Tilladte felter: ${allowed.join(', ')}. Er det en stavefejl?`,
        );
      }
    }
    return fields;
  }

  /**
   * A field's text, trimmed, with line breaks and double spaces folded to one
   * space. '' when the field is empty; undefined when it is missing or isn't
   * text (the latter is reported).
   */
  text(pair: Pair | undefined, label: string): string | undefined {
    return pair ? this.scalar(pair.value, label) : undefined;
  }

  /** Same as text(), for a value node (e.g. one item of a list). */
  scalar(value: unknown, label: string): string | undefined {
    if (value === null || value === undefined) return '';
    if (isScalar(value)) return String(value.value ?? '').replace(/\s+/g, ' ').trim();
    this.problem(
      value as Located,
      `${label} skal være en tekst${isSeq(value) ? ', ikke en liste' : ''}.`,
    );
    return undefined;
  }

  /** Where a field is, for messages: the field name's line. */
  at(pair: Pair | undefined): Located {
    return pair?.key as Located;
  }
}
