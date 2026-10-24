<?php
/**
 * Module speculative (SPEC.md 8.1, WPF-18, WPB-30): tune core speculative loading on WordPress 6.8+. Cart, checkout,
 * my-account, logout, add-to-cart links and URLs with query strings are always excluded. Without page caching every
 * prefetch is a full PHP render, so eagerness stays conservative unless the plan says the server has headroom.
 *
 * Settings: mode (prefetch|prerender), eagerness (conservative|moderate), excludePaths[].
 *
 * @package speedpilot-agent
 */

defined( 'ABSPATH' ) || exit;

add_filter(
	'wp_speculation_rules_configuration',
	function ( $config ) {
		if ( ! SpeedPilot_Flags::enabled( 'speculative' ) || is_user_logged_in() ) {
			return $config;
		}
		$s = SpeedPilot_Flags::settings( 'speculative' );
		return array(
			'mode'      => isset( $s['mode'] ) && 'prerender' === $s['mode'] ? 'prerender' : 'prefetch',
			'eagerness' => isset( $s['eagerness'] ) && in_array( $s['eagerness'], array( 'conservative', 'moderate' ), true ) ? $s['eagerness'] : 'conservative',
		);
	},
	20
);

add_filter(
	'wp_speculation_rules_href_exclude_paths',
	function ( $paths ) {
		if ( ! SpeedPilot_Flags::enabled( 'speculative' ) ) {
			return $paths;
		}
		$s      = SpeedPilot_Flags::settings( 'speculative' );
		$always = array( '/cart/*', '/checkout/*', '/my-account/*', '/*logout*', '/*add-to-cart=*', '/*\\?*', '/wp-login.php*' );
		return array_values( array_unique( array_merge( (array) $paths, $always, isset( $s['excludePaths'] ) ? (array) $s['excludePaths'] : array() ) ) );
	},
	20
);
