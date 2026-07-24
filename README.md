# HITS Hudson — Web en GitHub, solo Shopify

Esta versión sustituye Google Apps Script por:

- **GitHub Actions** para consultar Shopify de forma segura.
- **GitHub Pages** para mostrar el dashboard como sitio web.
- `docs/report-data.json` como archivo de datos generado.
- Configuración de metas en `config/goals.json`, sin conectarse a Google Sheets.

## Únicos Secrets necesarios

En **Settings → Secrets and variables → Actions → Secrets** crea únicamente:

- `SHOPIFY_STORE` = `equestrian-labs.myshopify.com`
- `SHOPIFY_TOKEN` = tu token privado `shpat_...`

No se necesita cuenta de servicio, Google Sheets API ni credenciales de Google.

## Configuración incluida en el repositorio

- `config/report-config.json`: versión API, ubicación, tag y fechas del proyecto.
- `config/goals.json`: semanas y metas de ventas.

Puedes editar `config/goals.json` directamente en GitHub para cambiar una meta semanal.

## Publicar como web

1. Sube todos los archivos a un repositorio usando la rama `main`.
2. Crea los dos Secrets de Shopify.
3. Ve a **Settings → Pages**.
4. En **Source**, selecciona **GitHub Actions**.
5. Ve a **Actions** y ejecuta `Update HITS Hudson report`.
6. El dashboard quedará publicado como una página web de GitHub Pages.

## Seguridad

El navegador nunca recibe `SHOPIFY_TOKEN`. GitHub Actions consulta Shopify y genera el JSON público que consume la web.

## Payback

La contribución real semanal es:

`Shopify Actual Gross Profit + Marketing Actual - OPEX Actual`

El cumulative cash y el payback actual/forecast se actualizan cada vez que GitHub Actions trae nuevos actuals de Shopify. Las semanas futuras utilizan forecast hasta que tengan datos reales.
