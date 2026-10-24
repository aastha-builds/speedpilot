<?php
/**
 * Plugin Name: SpeedPilot Staging Guard
 * Description: Neutralizes a staging copy so it cannot touch the business (SPEC.md 5.2): no outgoing email, no outgoing HTTP except allowlisted hosts, payments in test mode, webhooks and background jobs paused, noindex, optional HTTP basic auth. Install on staging and restore copies only.
 * Version: 0.1.0
 * Requires PHP: 7.4
 *
 * @package speedpilot-agent
 */

defined( 'ABSPATH' ) || exit;

if ( ! defined( 'SPEEDPILOT_STAGING' ) ) {
	define( 'SPEEDPILOT_STAGING', true );
}

/**
 * Appends a line to the guard log (wp-content/uploads/speedpilot/staging-guard.log).
 *
 * @param string $kind What was blocked.
 * @param array  $data Details.
 */
function speedpilot_staging_log( $kind, $data ) {
	$dir = WP_CONTENT_DIR . '/uploads/speedpilot';
	if ( ! is_dir( $dir ) ) {
		@mkdir( $dir, 0775, true ); // phpcs:ignore
	}
	@file_put_contents( $dir . '/staging-guard.log', gmdate( 'c' ) . ' ' . $kind . ' ' . wp_json_encode( $data ) . "\n", FILE_APPEND ); // phpcs:ignore
}

// 1. Email never leaves staging.
add_filter(
	'pre_wp_mail',
	function ( $null, $atts ) {
		speedpilot_staging_log( 'mail', array( 'to' => isset( $atts['to'] ) ? $atts['to'] : '', 'subject' => isset( $atts['subject'] ) ? $atts['subject'] : '' ) );
		return false;
	},
	PHP_INT_MAX,
	2
);

/**
 * Hosts staging may call: itself and an explicit allowlist (SPEEDPILOT_STAGING_ALLOW_HOSTS, comma-separated).
 *
 * @param string $host Host.
 * @return bool
 */
function speedpilot_staging_host_allowed( $host ) {
	$host    = strtolower( (string) $host );
	$allowed = array( 'localhost', '127.0.0.1', '::1', strtolower( (string) wp_parse_url( home_url(), PHP_URL_HOST ) ), strtolower( (string) wp_parse_url( site_url(), PHP_URL_HOST ) ) );
	if ( defined( 'SPEEDPILOT_STAGING_ALLOW_HOSTS' ) ) {
		$allowed = array_merge( $allowed, array_map( 'trim', explode( ',', strtolower( SPEEDPILOT_STAGING_ALLOW_HOSTS ) ) ) );
	}
	return in_array( $host, $allowed, true );
}

// 2. Outgoing HTTP (webhooks, CRM, ERP, payment APIs, inventory sync) is blocked unless allowlisted. Runs last.
add_filter(
	'pre_http_request',
	function ( $pre, $args, $url ) {
		$host = wp_parse_url( $url, PHP_URL_HOST );
		if ( speedpilot_staging_host_allowed( $host ) ) {
			return $pre;
		}
		speedpilot_staging_log( 'http', array( 'url' => preg_replace( '/\?.*$/', '', $url ), 'method' => isset( $args['method'] ) ? $args['method'] : 'GET' ) );
		return new WP_Error( 'speedpilot_staging_blocked', 'Outgoing HTTP is blocked on staging by SpeedPilot.' );
	},
	PHP_INT_MAX,
	3
);

// 3. Payments: only gateways that cannot take real money stay available.
add_filter(
	'woocommerce_available_payment_gateways',
	function ( $gateways ) {
		$offline = array( 'bacs', 'cheque', 'cod' );
		foreach ( (array) $gateways as $id => $gw ) {
			$test = in_array( $id, $offline, true );
			if ( ! $test && is_object( $gw ) ) {
				foreach ( array( 'testmode', 'sandbox', 'test_mode', 'environment' ) as $k ) {
					$v = method_exists( $gw, 'get_option' ) ? $gw->get_option( $k ) : '';
					if ( 'yes' === $v || 'sandbox' === $v || 'test' === $v ) {
						$test = true;
					}
				}
			}
			if ( ! $test ) {
				unset( $gateways[ $id ] );
			}
		}
		return $gateways;
	},
	PHP_INT_MAX
);

// 4. Webhooks and background jobs paused: WooCommerce webhook delivery, WP-Cron and Action Scheduler.
add_filter( 'woocommerce_webhook_should_deliver', '__return_false', PHP_INT_MAX );
add_filter( 'pre_get_ready_cron_jobs', function () {
	return array();
}, PHP_INT_MAX );
add_filter( 'action_scheduler_queue_runner_concurrent_batches', function () {
	return 0;
}, PHP_INT_MAX );
add_action(
	'init',
	function () {
		if ( class_exists( 'ActionScheduler_QueueRunner' ) ) {
			remove_action( 'action_scheduler_run_queue', array( ActionScheduler_QueueRunner::instance(), 'run' ) );
		}
	},
	1
);

// 5. noindex everywhere.
add_filter( 'pre_option_blog_public', function () {
	return '0';
} );
add_filter( 'wp_robots', function ( $robots ) {
	$robots['noindex']  = true;
	$robots['nofollow'] = true;
	return $robots;
} );
add_action( 'send_headers', function () {
	header( 'X-Robots-Tag: noindex, nofollow', true );
} );

// 6. Optional HTTP basic auth (SPEEDPILOT_STAGING_AUTH = 'user:password').
if ( defined( 'SPEEDPILOT_STAGING_AUTH' ) && SPEEDPILOT_STAGING_AUTH && ! ( defined( 'WP_CLI' ) && WP_CLI ) && ! wp_doing_cron() ) {
	list( $spg_user, $spg_pass ) = array_pad( explode( ':', SPEEDPILOT_STAGING_AUTH, 2 ), 2, '' );
	$given_user = isset( $_SERVER['PHP_AUTH_USER'] ) ? (string) $_SERVER['PHP_AUTH_USER'] : ''; // phpcs:ignore
	$given_pass = isset( $_SERVER['PHP_AUTH_PW'] ) ? (string) $_SERVER['PHP_AUTH_PW'] : ''; // phpcs:ignore
	if ( ! hash_equals( $spg_user, $given_user ) || ! hash_equals( $spg_pass, $given_pass ) ) {
		header( 'WWW-Authenticate: Basic realm="Staging"' );
		header( 'HTTP/1.1 401 Unauthorized' );
		exit( 'Staging' );
	}
}
