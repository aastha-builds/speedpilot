# SpeedPilot agent (WordPress mu-plugin)

Install: copy `speedpilot-agent.php` and the `speedpilot-agent/` folder into `wp-content/mu-plugins/`, and add a secret to
`wp-config.php` for token-authenticated diagnostics:

```php
define( 'SPEEDPILOT_HMAC_SECRET', '<at least 32 random characters>' ); // same value as the env var named in site.yaml
```

- Does nothing unless a flag is on. Flags live in one autoloaded option (`speedpilot_flags`), versioned, exportable
  (`wp speedpilot export`) and importable (`wp speedpilot import flags.json`).
- Kill switch: `define( 'SPEEDPILOT_DISABLE', true );` in wp-config.php, or rename `speedpilot-agent.php` over SFTP.
  Logged-in admins can compare any page with `?speedpilot=off`; it never works for the public.
- Diagnostics (Application Password user with `manage_options`, or an HMAC token valid for at most 5 minutes):
  `GET /wp-json/speedpilot/v1/{ping,env,autoload,cron,flags}`; front-end token requests get a handle map (source,
  version, deps, strategy, footer, inline before/after/data) and a `Server-Timing` header. On local, development and
  staging environments only, token requests also record slow queries with their caller and outgoing HTTP calls.
  Never on production (CLAUDE.md rule 12).
- WordPress 6.9+: the read-only diagnostics are also registered as Abilities (`speedpilot/environment`,
  `speedpilot/autoload`, `speedpilot/cron`).
- Tools > SpeedPilot shows active flags, last change, change log and the kill switch. Nothing else.
- PHP 7.4 syntax only, WordPress Coding Standards, no Composer runtime dependencies, no outgoing calls.

## Tests

`pnpm test:php` runs `tests/agent-tests.php` (TAP) and the kill-switch test inside the local fixture on PHP 7.4, 8.3 and
8.4 (compose engine). With wp-env: `npx wp-env run cli wp eval-file /var/www/html/wp-content/mu-plugins/speedpilot-agent/../../../agent-tests/agent-tests.php`
after mapping `packages/wp-agent/tests` to `agent-tests` in `.wp-env.json`.
