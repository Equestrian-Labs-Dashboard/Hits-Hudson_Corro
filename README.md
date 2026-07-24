# HITS Hudson — GitHub Pages (diseño original intacto)

Esta versión conserva exactamente el HTML y CSS del Apps Script original. Solo agrega un puente técnico para que `google.script.run` lea `docs/report-data.json` en GitHub Pages.

## Credenciales requeridas

Crea únicamente estos Repository Secrets en GitHub Actions:

- `SHOPIFY_STORE` — ejemplo: `equestrian-labs.myshopify.com`
- `SHOPIFY_TOKEN` — token privado `shpat_...`

No requiere Google Sheets, Google Cloud ni cuenta de servicio.

## Pasos

1. Sube todo el contenido de esta carpeta a la raíz de un repositorio GitHub.
2. Ve a **Settings → Secrets and variables → Actions**.
3. Crea los dos secrets indicados arriba.
4. Ve a **Settings → Pages** y selecciona **GitHub Actions** como Source.
5. Ve a **Actions → Update HITS Hudson report → Run workflow**.
6. Cuando termine, el workflow de Pages publicará la web.

Las metas están en `config/goals.json`. El diseño está en `docs/index.html` y corresponde al diseño original.


## Fix for empty week error
The included placeholder report now contains all configured weeks, so the page no longer crashes before the first Shopify refresh. Run the `Update HITS Hudson report` workflow to replace zero values with live Shopify data.
