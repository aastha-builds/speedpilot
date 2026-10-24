<?php
/**
 * Module plugin-elementor (SPEC.md 8.1, WPF-08): Elementor front-end assets only on pages built with Elementor.
 * Elementor's own performance features (optimized asset loading, font-display) are switched on one at a time as
 * scripted option steps, never Element Caching (CLAUDE.md rule 3).
 *
 * Settings: handles[] (script and style handles to keep off pages not built with Elementor).
 *
 * @package speedpilot-agent
 */

defined( 'ABSPATH' ) || exit;

add_action(
	'wp_enqueue_scripts',
	function () {
		if ( ! SpeedPilot_Flags::enabled( 'plugin-elementor' ) ) {
			return;
		}
		$id = is_singular() ? get_queried_object_id() : 0;
		if ( $id && 'builder' === get_post_meta( $id, '_elementor_edit_mode', true ) ) {
			return;
		}
		$s = SpeedPilot_Flags::settings( 'plugin-elementor' );
		$h = ! empty( $s['handles'] ) ? (array) $s['handles'] : array( 'elementor-frontend', 'elementor-webpack-runtime', 'elementor-frontend-modules', 'elementor-waypoints', 'elementor-icons', 'elementor-common' );
		foreach ( $h as $handle ) {
			wp_dequeue_script( $handle );
			wp_dequeue_style( $handle );
		}
	},
	9999
);
