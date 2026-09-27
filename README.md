# TONI Works – toniworks.dk

Portfoliosite for produktionsselskabet TONI Works (Tobias Franck-Winther og
Nicolas Kaiser): en forside med filmene, en side pr. film, About og 404.

**Ejerne redigerer indholdet selv på GitHub. Se [GUIDE.md](GUIDE.md).**

## Stack

- [Astro](https://astro.build) 7, statisk output (ingen adapter, ingen server).
  Node 24.
- Ingen backend, database, cookies, analytics eller tredjepartsrequests. Fonte er
  self-hosted via Fontsource. Indholdet ligger i git og bliver læst ved build.
  Der er derfor ikke brug for fx Supabase.
- Hostet på Vercel fra GitHub-repoet `papafrancko/toniworks`, branch `main`.
- Film kodes med ffmpeg (libx264, libsvtav1, aac) og ligger i git under
  `src/assets/films/`.

## Lokalt

```sh
npm install
npm run dev      # http://localhost:4321
npm run check    # astro check
npm run build    # -> dist/
```

## Scripts

| Kommando | Hvad |
|---|---|
| `npm run media` | Koder lanceringsfilmene fra `materiale/opslag/` (ikke i git) og tjekker alle filer. Eksisterende filer genkodes kun med `-- --force`. `-- --selftest` tjekker ffmpeg. `-- --only=<slug> --source=<master>` koder én film fra en vilkårlig master. |
| `npm run brand` | Genererer favicon, apple-touch-icon og `og-default.png` ud fra vektor-wordmarket. |
| `npm run film:add -- --link <url\|fil> --titel <titel> [--kunde SALTY]` | Det samme som formularen "Tilføj film": henter, tjekker, koder og sætter filmen sidst i `film.yaml`. |
| `npm run film:remove -- --slug <slug>` | Det samme som formularen "Fjern film". |

ffmpeg/ffprobe findes via env `FFMPEG`/`FFPROBE`, så `PATH`, og på Windows til
sidst via winget-pakken Gyan.FFmpeg.

## Hvor ligger hvad

| Sti | Indhold |
|---|---|
| `src/content/film.yaml` | Filmlisten. Rækkefølge = forside og "næste film". `skjult: true` skjuler en film. Redigeres af ejerne. |
| `src/content/tekster.yaml` | About, kontakt, credit-linje og firmaoplysninger (e-handelsloven § 7). Redigeres af ejerne. |
| `src/assets/films/<slug>/` | `full-2048.{av1,h264}.mp4`, `full-1280.{av1,h264}.mp4`, `poster.jpg` (billede 0). Genereret. |
| `src/data/media-manifest.json` | Varighed, codec-strenge, `controlsScrim`, kontrastmålinger. Genereret, må ikke rettes i hånden. |
| `src/data/films.ts`, `site.ts`, `content-file.ts` | Læser YAML (failsafe-skema: alt er tekst) og stopper build med en dansk fejl med linjenummer. |
| `scripts/` | `encode-media.mjs`, `add-film.mjs`, `remove-film.mjs`, `film-yaml.mjs` (redigerer `film.yaml` uden at røre kommentarer), `make-brand.mjs`. |
| `.github/workflows/` | `tilfoej-film.yml` og `fjern-film.yml` (formularer, pusher til `main` som github-actions[bot]), `tjek.yml` ("Tjek bygning": `npm ci`, `astro check`, `astro build` ved hver push/PR). |

`materiale/` (masters) og `design-handoffs/` er i `.gitignore`.

## Designregler (fra kunden, må ikke brydes)

1. Filmene klippes, trimmes, laves om til loop-klip eller redigeres **aldrig**
   (forsiden afspiller hele filmen i loop). Hver fil er hele filmen. Kun format
   (AV1/H.264) og størrelse (2048/1280 bred) ændres.
2. Filmene er 2048 × 1340 og vises altid i det forhold (`aspect-ratio: 2048 / 1340`).
   Aldrig beskåret, aldrig letterboxet i 16:9.
3. Plakaten er filmens billede 0. Ingen spinner, skeleton eller loadingtekst.
4. Minimal UI: kun hvid (#FFFFFF) og grå (#9AA0AB) tekst på #0A0D14. Ingen ikoner,
   border-radius, skygger, gradienter eller accentfarver.
5. `prefers-reduced-motion`: kun plakater på forsiden, ingen autoplay.
6. Al tekst er på dansk.

## Deployment og domæne

**Vercel:** Importér GitHub-repoet som nyt projekt. Framework "Astro" bliver
fundet automatisk (build `astro build`, output `dist`, Node 24 fra `engines`).
Hver push til `main` bliver en ny production-version. Fejler et build, bliver den
forrige version liggende. Rollback: Deployments → ⋯ → Instant Rollback.

**Plan:** Vercel Hobby. Hobby kan kun importere repos, der ejes af en personlig
GitHub-konto, og kontoen skal være den samme, som ejer Vercel-projektet. Derfor
ligger repoet på `papafrancko` (Tobias), som også ejer Vercel-projektet. Tobias og Nicolas er collaborators med
skriveadgang. Repoet er offentligt, så Vercel deployer også deres commits og
formularernes bot-commits (på Hobby gælder begrænsningen kun private repos).
Vercels fair use-vilkår beskriver Hobby som ikke-kommerciel brug.

**Domæne:** Domænet tilføjes i Vercel, men DNS bliver hos Simply.com.

1. I Vercel: Settings → Domains → tilføj `www.toniworks.dk` (primært domæne) og
   `toniworks.dk`, og sæt `toniworks.dk` til at redirecte (308) til www.
2. Hos Simply.com (DNS for toniworks.dk). Brug præcis de værdier, som Vercels
   domænekort viser:
   - **apex:** ret A-recorden `@` fra Simplys parkerings-IP til Vercels IP (fx
     `76.76.21.21` eller `216.198.79.1`).
   - **www:** opret en CNAME `www` til projektets Vercel-mål (fx
     `xxxxxxxx.vercel-dns-017.com.`). Den tilsidesætter wildcard-recorden `*`, som
     gerne må slettes.
   - Ingen AAAA-records.
   - **Rør ikke MX (`mx.simply.com`) og SPF** (`v=spf1 include:spf.simply.com -all`).
     Ellers holder mail på @toniworks.dk op med at virke.
3. **Flyt ikke nameservers til Vercel.** Simply signerer zonen (DNSSEC), og Vercel
   DNS understøtter ikke DNSSEC.
4. Tjek: Vercel viser "Valid Configuration", og `http://toniworks.dk` redirecter
   til `https://www.toniworks.dk`. Certifikatet laver Vercel selv.

## Kendte begrænsninger

- Skjulte film (`skjult: true`) har ingen side eller link, men deres videofiler
  kopieres stadig til `dist/_astro`. "Fjern film" fjerner dem helt.
- Bottens egne commits (fra Tilføj/Fjern film) starter ikke "Tjek bygning", fordi
  GitHub ikke starter workflows fra `GITHUB_TOKEN`. De kører selv check og build,
  før de pusher.
- Forsidens videoer har `preload="none"`, ikke `metadata` som i designbriefen:
  med `metadata` henter Chrome 1–6 MB pr. film, før nogen rører siden, og det
  forsinker fonte og plakater. Med mus sætter `src/scripts/previews.ts`
  `preload="metadata"` på filmene i view, når siden er indlæst, så et hover
  starter med det samme. På touch hentes en film først, når den spiller.
- ffmpeg i CI er fastlåst til en BtbN-build (URL og SHA256 i `tilfoej-film.yml`).
  Forsvinder den, bruges den seneste 9.0-build med en advarsel.
