# Shopify fixture theme

A Horizon-family-style theme (Online Store 2.0 JSON templates, nested theme blocks, `content_for 'blocks'`) written from
scratch for SpeedPilot tests, with the planted problems from SPEC.md section 11 (see `../PLANTED.md`). It contains no
Shopify theme code. To test against Shopify's real Horizon or Dawn, pull a copy into `fixtures/shopify/horizon/` from
your development store (`shopify theme pull`) and re-plant the same problems there.

## Push to your development store (unpublished)

1. Create a free development store in your Shopify Partner account.
2. Log in once: `shopify auth login` (or use a Theme Access password).
3. Push as a new unpublished theme:

   ```
   SHOPIFY_FIXTURE_STORE=<your-store>.myshopify.com pnpm fixtures:shopify push
   ```

   This runs `shopify theme push --unpublished`. It never publishes and never uses `--live` or `--allow-live`.
4. Check the planted offences: `shopify theme check --path fixtures/shopify/theme` (or offline: `pnpm fixtures:shopify check`).

Expected Theme Check offences: `ParserBlockingScript` (layout/theme.liquid, 3), `RemoteAsset` (theme.liquid and the
leftover app snippet), `ImgWidthAndHeight` (hero), `DeprecatedFilter` (`img_url` in the hero).

## Local preview (no store needed)

`pnpm build && pnpm fixtures:shopify preview` serves the theme on http://localhost:9292 with mock products (120 products,
6 variants each, so the planted nested loop costs real render time), a stand-in for the platform scripts that
`content_for_header` injects, Shopify's `Speculation-Rules` header and an emulated `theme profile` at `/__profile`.
It is a test harness, not Shopify: numbers from it are labelled "local preview".
