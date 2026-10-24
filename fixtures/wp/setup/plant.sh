#!/bin/sh
# Runs inside the WP-CLI container (compose) or `wp-env run cli` (wp-env). Local fixture only.
set -e
wp core is-installed 2>/dev/null || wp core install --url=http://localhost:8888 --title="SpeedPilot Fixture" --admin_user=admin --admin_password=password --admin_email=admin@example.com --skip-email
wp rewrite structure '/%postname%/' --hard 2>/dev/null || wp rewrite structure '/%postname%/'
for p in woocommerce elementor contact-form-7 smart-slider-3; do
  if wp plugin is-installed "$p"; then wp plugin activate "$p" || true; fi
done
wp theme activate speedpilot-fixture
wp option update woocommerce_coming_soon no 2>/dev/null || true
wp option update woocommerce_onboarding_profile '{"skipped":true}' --format=json 2>/dev/null || true
wp spf plant
