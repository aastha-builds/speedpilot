<?php
/**
 * Module plugin-cf7 (SPEC.md 8.1, WPF-06): Contact Form 7 assets only on pages with a form, through the
 * wpcf7_load_js and wpcf7_load_css filters, then wpcf7_enqueue_scripts() where a form exists. The SAFE-05 usage scan
 * (content, widgets, menus, builder data, templates) decides the page list before this flag goes on.
 *
 * Settings: rules (templates or URLs that keep the assets), detectShortcode (also keep them on any singular page whose
 * content has a form shortcode or block).
 *
 * @package speedpilot-agent
 */

defined( 'ABSPATH' ) || exit;

/**
 * Does this request need Contact Form 7 assets?
 *
 * @return bool
 */
function speedpilot_cf7_needed() {
	$s = SpeedPilot_Flags::settings( 'plugin-cf7' );
	if ( ! empty( $s['rules'] ) && SpeedPilot_Flags::rules_match( (array) $s['rules'] ) ) {
		return true;
	}
	if ( ! isset( $s['detectShortcode'] ) || $s['detectShortcode'] ) {
		$post = get_queried_object();
		if ( $post instanceof WP_Post && ( has_shortcode( $post->post_content, 'contact-form-7' ) || has_block( 'contact-form-7/contact-form-selector', $post ) ) ) {
			return true;
		}
	}
	return false;
}

add_filter(
	'wpcf7_load_js',
	function ( $load ) {
		return SpeedPilot_Flags::enabled( 'plugin-cf7' ) && did_action( 'wp' ) && ! speedpilot_cf7_needed() ? false : $load;
	}
);
add_filter(
	'wpcf7_load_css',
	function ( $load ) {
		return SpeedPilot_Flags::enabled( 'plugin-cf7' ) && did_action( 'wp' ) && ! speedpilot_cf7_needed() ? false : $load;
	}
);
// Stand-ins and older versions that enqueue without the filters: dequeue the same handles.
add_action(
	'wp_enqueue_scripts',
	function () {
		if ( SpeedPilot_Flags::enabled( 'plugin-cf7' ) && ! speedpilot_cf7_needed() ) {
			wp_dequeue_script( 'contact-form-7' );
			wp_dequeue_script( 'swv' );
			wp_dequeue_style( 'contact-form-7' );
		}
	},
	9999
);
