<?php
/**
 * Module asset-control (SPEC.md 8.1): dequeue handles that are provably unused on a template (SAFE-05 usage scan),
 * add defer or async through the WordPress 6.3+ strategy data, script fetchpriority (6.9+), move scripts to the footer.
 * SpeedPilot writes a defer, async or dequeue entry here only after an X-ray `safe` verdict and a passing simulation
 * (SPEC.md 15.5). WordPress itself still downgrades a strategy when a blocking dependent needs the script.
 *
 * Settings: dequeue[] {handle, type: script|style, rules}, strategy {handle: defer|async}, footer[], fetchpriority {handle: high|low|auto}.
 *
 * @package speedpilot-agent
 */

defined( 'ABSPATH' ) || exit;

add_action(
	'wp_enqueue_scripts',
	function () {
		if ( ! SpeedPilot_Flags::enabled( 'asset-control' ) ) {
			return;
		}
		$s = SpeedPilot_Flags::settings( 'asset-control' );
		foreach ( isset( $s['dequeue'] ) ? (array) $s['dequeue'] : array() as $item ) {
			if ( empty( $item['handle'] ) || ! SpeedPilot_Flags::rules_match( isset( $item['rules'] ) ? (array) $item['rules'] : array() ) ) {
				continue;
			}
			if ( isset( $item['type'] ) && 'style' === $item['type'] ) {
				wp_dequeue_style( $item['handle'] );
			} else {
				wp_dequeue_script( $item['handle'] );
			}
		}
		foreach ( isset( $s['strategy'] ) ? (array) $s['strategy'] : array() as $handle => $strategy ) {
			if ( in_array( $strategy, array( 'defer', 'async' ), true ) ) {
				wp_script_add_data( $handle, 'strategy', $strategy );
			}
		}
		foreach ( isset( $s['footer'] ) ? (array) $s['footer'] : array() as $handle ) {
			wp_script_add_data( $handle, 'group', 1 );
		}
		foreach ( isset( $s['fetchpriority'] ) ? (array) $s['fetchpriority'] : array() as $handle => $priority ) {
			if ( in_array( $priority, array( 'high', 'low', 'auto' ), true ) ) {
				wp_script_add_data( $handle, 'fetchpriority', $priority );
			}
		}
	},
	9999
);
