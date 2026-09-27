# Guide til toniworks.dk

For Tobias og Nicolas. Alt, hvad I skal bruge, er GitHubs hjemmeside.

**Sådan virker det:** Hele sitet ligger som filer i projektet
[papafrancko/toniworks](https://github.com/papafrancko/toniworks)
på GitHub. Når I gemmer en ændring dér, laver Vercel (tjenesten, der viser
sitet på nettet) automatisk en ny version af toniworks.dk. Det tager ca. 2
minutter. Er der en fejl i ændringen, bliver den gamle version liggende online,
så sitet går aldrig ned af en tastefejl.

I kan gøre fire ting:

| Hvad | Hvor |
|---|---|
| Tilføje en film | Formularen **Tilføj film** under fanen **Actions** |
| Fjerne en film | Formularen **Fjern film** under fanen **Actions** |
| Ændre rækkefølge, titler, skjule en film | Filen `src/content/film.yaml` |
| Rette tekster (About, kontakt, CVR) | Filen `src/content/tekster.yaml` |

GitHub og Vercel er på engelsk, så knapperne står her med deres engelske navne.

---

## Sådan tilføjer I en film

**Krav til masterfilen**

- **2048 × 1340 pixels.** Samme form i højere opløsning går også (fx 4096 × 2680).
  Alle andre formater bliver afvist, også rigtig 3:2 som 1920 × 1280, fordi sitet
  aldrig beskærer eller strækker billedet.
- **Med lyd.** En film uden lyd får et stille lydspor, og I får en advarsel.
- Højst 3 minutter. Almindelige farver (Rec. 709, ikke HDR), fast billedhastighed
  (fx 25 fps), ikke roteret.
- **Det allerførste billede bliver filmens stillbillede** på forsiden og under
  indlæsning. Sørg for, at det er et godt billede og ikke sort.

**Trin for trin**

1. Læg masterfilen i Dropbox.
2. Klik på **Del** ud for filen i Dropbox, og klik **Kopiér link**. Linket skal
   pege på selve filen (ikke mappen) og være delt med "Alle med linket".
3. Gå til [github.com/papafrancko/toniworks](https://github.com/papafrancko/toniworks), og log ind.
4. Klik på fanen **Actions** øverst.
5. Klik på **Tilføj film** i listen til venstre.
6. Klik på knappen **Run workflow** til højre. Der folder sig en lille formular ud.
7. Lad "Branch: main" stå. Udfyld felterne:
   - **Link til masterfilen:** indsæt Dropbox-linket.
   - **Titel:** titlen, som den skal stå på sitet, fx `vågne`.
   - **Kunden:** `SALTY` står der i forvejen.
8. Klik på den grønne **Run workflow**.
9. Efter et par sekunder dukker linjen "Tilføj film: *titel*" op med en gul prik
   (den kører). Genindlæs siden, hvis den ikke kommer.
10. Vent, typisk 5–30 minutter afhængigt af filmens længde. Den gule prik bliver til:
    - **grønt ✓**: filmen er gemt. Vercel lægger den online ca. 2 minutter efter.
      Klik på linjen for at se en opsummering med titel, adresse og længde.
    - **rødt ✗**: filmen blev *ikke* tilføjet, og intet er ændret på sitet. Klik på
      linjen. Forklaringen står på dansk under **Annotations** og nederst på siden,
      fx at filmen har et forkert format, eller at linket peger på en mappe. Ret
      det, og kør **Tilføj film** igen.
    - **gråt ⊘**: kørslen blev afbrudt, og intet er ændret på sitet. Kør **Tilføj
      film** igen.

**Godt at vide**

- Den nye film kommer **sidst** på forsiden. Flyt den i `film.yaml`, hvis den skal stå
  et andet sted (se næste afsnit).
- Adressen laves ud fra titlen, fx "vågne op" → toniworks.dk/film/vaagne-op. Den
  ændrer sig ikke, hvis I senere retter titlen.
- Tilføj én film ad gangen: vent på det grønne ✓, før I starter den næste, og ret
  ikke `film.yaml`, mens en film er ved at blive tilføjet.
- Dropbox er det sikreste. Et direkte download-link virker også. WeTransfer, YouTube,
  Vimeo og mapper i Google Drive virker ikke.

---

## Sådan ændrer I rækkefølge, titler eller skjuler en film

Alle film står i filen `src/content/film.yaml`, én blok pr. film.
Rækkefølgen i filen er rækkefølgen på forsiden og i "næste film":

```yaml
- slug: loeb      # adressen: toniworks.dk/film/loeb
  titel: løb
  kunde: SALTY
```

`slug` er filmens adresse. Linjer, der starter med `#`, er forklaringer og vises
ikke på sitet.

1. Åbn [src/content/film.yaml](https://github.com/papafrancko/toniworks/blob/main/src/content/film.yaml) på GitHub.
2. Klik på **blyanten** ("Edit this file") øverst til højre over filen.
3. Ret det, I vil:
   - **Rækkefølge:** Flyt hele blokken (alle dens linjer, også `skjult: true`, hvis
     den står der) op eller ned, fx med Ctrl+X og Ctrl+V. Lad der være en tom linje
     mellem blokkene.
   - **Titel:** Ret teksten efter `titel:`. Er der et kolon i titlen, skal den i
     anførselstegn: `titel: "løb: del 2"`.
   - **Skjul en film:** Tilføj linjen `  skjult: true` under `kunde:`, med to
     mellemrum foran ligesom de andre linjer. Slet linjen igen for at vise filmen.
   - **Ret aldrig `slug`**, når filmen er online. Så holder links til filmen op med
     at virke.
4. Klik på den grønne **Commit changes…** øverst til højre ("commit" betyder gem).
   Lad "Commit directly to the main branch" være valgt, og klik **Commit changes**.
5. Sitet er opdateret efter ca. 2 minutter.

**Grønt ✓ eller rødt ✗:** På projektets forside står der ud for den nyeste ændring
først en gul prik, derefter et ✓ eller ✗. Det er tjekkene **Tjek bygning** og Vercel.

- **✓** betyder, at alt er i orden.
- **✗** betyder, at der er en tastefejl i filen. Den gamle version af sitet bliver
  liggende online. Klik på ✗ og så **Details**. Beskeden siger på dansk, hvilken linje der er
  noget galt med, og hvad der mangler, fx `Linje 52: filmen "loeb" mangler "titel:"`. Ret linjen
  på samme måde, og gem igen.

**Fortryd en ændring**

1. Åbn filen på GitHub, og klik på **History** øverst til højre. I ser alle gemte
   versioner med dato.
2. Klik på den sidste version, der var rigtig. Klik på **⋯** ud for filnavnet, og
   vælg **View file**.
3. Klik på knappen **Copy raw file** (ved siden af "Raw"). Nu er hele den gamle
   fil kopieret.
4. Åbn den nuværende fil, klik på blyanten, marker alt (Ctrl+A), indsæt (Ctrl+V), og
   klik **Commit changes**.

Film, der er tilføjet eller fjernet med formularerne, fortryder I med den anden
formular i stedet.

---

## Sådan retter I tekster

Teksterne står i
[src/content/tekster.yaml](https://github.com/papafrancko/toniworks/blob/main/src/content/tekster.yaml).
I retter og gemmer ligesom i `film.yaml` (blyanten → ret → **Commit changes**).

| Felt | Hvad det er |
|---|---|
| `about` → `indledning` | Den store første tekst på about-siden |
| `about` → `afsnit` | Afsnittene under den. Hvert afsnit starter med `- >-`. Det nuværende afsnit er en pladsholder, der venter på jeres egen tekst. |
| `about` → `sidste_linje` | Den grå linje til sidst. Fjern den ved at rette linjen til `sidste_linje: ''` (slet `>-` og teksten under). |
| `kontakt` → `email` | Mailadressen nederst på hver side |
| `kontakt` → `tekst` | Den grå linje under mailadressen |
| `kontakt` → `instagram` | Navnet på Instagram, uden @ (fx `toni__works`) |
| `kontakt` → `by` | Byen nederst på siden |
| `film` → `produceret_af` | Navnene i "Produceret for SALTY af …" |
| `firma` → `navn`, `adresse`, `cvr` | Firmaoplysninger. De vises nederst under © fra det øjeblik, de er udfyldt. Loven (e-handelsloven § 7) kræver, at et firmas website viser dem. CVR er 8 cifre. |

Regler, der holder filen læsbar:

- Lad feltnavnene stå, dvs. alt før kolon.
- Ryk ind med mellemrum, aldrig med tabulator, og lige så langt som linjerne omkring.
- Lange tekster står på linjerne under `>-`. Der må I bryde linjerne, hvor I vil,
  og bruge kolon og anførselstegn frit. På sitet bliver det ét afsnit.

---

## Sådan fjerner I en film

Skal filmen bare væk et stykke tid, så skjul den med `skjult: true` i stedet (se ovenfor).
**Fjern film** sletter filmens videofiler fra sitet.

1. Gå til fanen **Actions**, og klik på **Fjern film** til venstre.
2. Klik **Run workflow**.
3. Skriv filmens adresse, dvs. det, der står efter `/film/`, fx `loeb`. Hele
   linket virker også.
4. Klik den grønne **Run workflow**. Efter et par minutter får kørslen et grønt ✓,
   og ca. 2 minutter senere er filmen væk fra sitet.

Findes adressen ikke, får I et rødt ✗ med en liste over de adresser, der findes.
Vil I have filmen tilbage, så tilføj den igen fra masterfilen med **Tilføj film**.

---

## Hvis noget går galt

- **En fejl tager aldrig sitet ned.** Kan Vercel ikke bygge den nye version, bliver
  den forrige liggende online.
- **Rødt ✗ efter en rettelse:** Læs beskeden (se ovenfor), og ret linjen, eller
  fortryd ændringen.
- **Rødt ✗ ved Tilføj film / Fjern film:** Intet er ændret. Læs forklaringen, og kør igen.
- **Gråt ⊘ ved Tilføj film / Fjern film:** Kørslen blev afbrudt. Intet er ændret. Kør igen.
- **Sitet ser forkert ud, selvom alt er grønt:** Fortryd ændringen på GitHub. Haster
  det, kan I sætte den forrige version online med det samme i Vercel:
  1. Log ind på [vercel.com](https://vercel.com), og åbn projektet toniworks.
  2. Klik på fanen **Deployments**. Hver linje er en version af sitet.
  3. Find den sidste version, der var rigtig. Klik på **⋯** yderst til højre, og vælg
     **Instant Rollback** (hedder nogle gange **Promote**). Bekræft. Den gamle version
     er online efter få sekunder.
  4. Vigtigt: Efter en rollback lægger Vercel ikke nye ændringer online af sig selv.
     Når fejlen er rettet på GitHub, så klik **Undo Rollback** på projektets forside
     i Vercel.
- **Kontakt:** Send linket til den side, hvor fejlen står (kørslen under Actions
  eller ✗'et), til udvikleren. Den, der har sat sitet op, ejer
  GitHub-kontoen [christianolin](https://github.com/christianolin).

---

## Godt at vide

- **Filmene bliver aldrig klippet.** Hver fil er hele filmen, fra første til sidste
  billede, med den originale lyd. Kun filformat og størrelse ændres.
- **Stillbilledet er filmens første billede.** Vil I have et andet, skal filmen
  eksporteres, så den starter på det billede.
- **Ny version af en film:** Kør **Fjern film** og derefter **Tilføj film** med samme
  titel. Så får den samme adresse igen, men kommer sidst, så I skal flytte den.
- **Hver film bliver til fire videofiler**, 2048 og 1280 pixels brede, i to
  formater (AV1 og H.264), så alle browsere og telefoner kan vise dem, plus
  stillbilledet. Hver fil holdes under 25 MB. Lange film med meget grain bliver
  komprimeret lidt mere for at nå det.
- **Længden** ("16 sek.") og den **mørke bjælke** bag afspillerens knapper (på film
  med lys bund) laves automatisk.
- **Plads:** De nuværende film fylder 15–60 MB hver i projektet. Der er plads til
  mange film, flere dusin. Fjernede film ligger stadig i GitHubs historik.
