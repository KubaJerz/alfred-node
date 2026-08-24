# Archivo (bundled for the strength dashboard)

`strength/plot.py` renders the dashboard PNG in Archivo — the typeface of the
design it reproduces. matplotlib needs static `.ttf` files (and handles
variable-font weight axes unreliably), so these three weights were instanced
from the upstream variable font with `fontTools.varLib.instancer` at
`wght` 400 / 600 / 700, `wdth` 100:

- `Archivo-Regular.ttf`  — 400
- `Archivo-SemiBold.ttf` — 600
- `Archivo-Bold.ttf`     — 700

Source: <https://github.com/google/fonts/tree/main/ofl/archivo>.
Archivo is licensed under the SIL Open Font License 1.1 — see `OFL.txt`.
If Archivo is ever absent here, `plot.py` falls back to the default sans-serif.
