# HITS Hudson — GitHub version

This repository replaces Google Apps Script with:

- **GitHub Actions** as the secure backend job.
- **GitHub Secrets** for Shopify and Google credentials.
- **GitHub Variables** for non-secret configuration.
- **GitHub Pages** for the dashboard.
- `docs/report-data.json` as the generated data source.

## 1. Create the repository

Upload all files to a new GitHub repository and use `main` as the default branch.

## 2. Repository secrets

Go to **Settings → Secrets and variables → Actions → Secrets** and create:

- `SHOPIFY_TOKEN`: Shopify Admin API access token.
- `GOOGLE_SERVICE_ACCOUNT_JSON`: complete Google service-account JSON, stored as one line/secret.

Share the GOALS spreadsheet with the service account email as **Viewer**.

## 3. Repository variables

Under **Variables**, create:

- `SHOPIFY_STORE` = `your-store.myshopify.com`
- `SHOPIFY_API_VERSION` = `2026-07`
- `HITS_LOCATION_ID` = `67063775290`
- `HITS_LOCATION_NAME` = `Corro Trailer 1`
- `HITS_ORDER_TAG` = `HitsHudson`
- `GOALS_SPREADSHEET_ID` = spreadsheet ID
- `GOALS_SHEET_NAME` = `GOALS`
- `PROJECT_WEEKS` = `12`
- `PROJECT_START_DATE` = `2026-06-01`

## 4. Enable Pages

Go to **Settings → Pages → Source → GitHub Actions**. Then run **Update HITS Hudson report** manually once from the Actions tab.

## Payback correction

There are now three different values:

1. **Budget payback**: budget contribution every included week.
2. **Actual-only payback**: only real started-week contributions; it can remain “Not reached.”
3. **Actual + forecast payback**: real contribution for started weeks and budget contribution for future weeks.

The actual contribution formula is:

`Shopify Actual Gross Profit + Manual Marketing Actual - Manual OPEX Actual`

So yes: the actual/forecast cumulative cash and payback update whenever the Shopify actuals change.

## Local test

```bash
npm install
npm run check
npm run generate
```

Use a local `.env` loader or export the values from `.env.example`; never commit real secrets.
