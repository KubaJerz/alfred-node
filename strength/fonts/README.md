# Fonts (bundled for the strength dashboard)

`strength/plot.py` renders the "Strength Load" figure in the typefaces of the
design it reproduces: **Cormorant Garamond** (the big numerals + section
headings) and **Lora** (body text and the tracked labels). matplotlib needs
static `.ttf` files and handles variable-font weight axes unreliably, so these
weights were instanced from the upstream variable fonts with
`fontTools.varLib.instancer`:

- `CormorantGaramond-Light.ttf`   — 300  (hero numeral, headings, trend words)
- `CormorantGaramond-Regular.ttf` — 400  (stat values, muscle names, 7d load)
- `CormorantGaramond-Medium.ttf`  — 500  (per-muscle ratio numbers)
- `Lora-Regular.ttf`              — 400  (body paragraphs, labels)
- `Lora-Medium.ttf`              — 500

Sources: <https://github.com/google/fonts/tree/main/ofl/cormorantgaramond> and
<https://github.com/google/fonts/tree/main/ofl/lora>. Both are licensed under the
SIL Open Font License 1.1 — see `OFL-Cormorant.txt` and `OFL-Lora.txt`. If a font
is ever absent here, `plot.py` falls back to the default serif.
