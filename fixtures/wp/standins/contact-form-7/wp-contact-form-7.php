<?php
/**
 * Plugin Name: Contact Form 7 (SpeedPilot stand-in)
 * Description: Sandbox stand-in with the same slug, handles and loading filters as Contact Form 7. Written from scratch; no vendor code.
 * Version: 6.1-standin
 *
 * @package speedpilot-fixture
 */

defined( 'ABSPATH' ) || exit;

define( 'WPCF7_VERSION', '6.1-standin' );

add_action( 'init', function () {
	register_post_type( 'wpcf7_contact_form', array( 'public' => false, 'label' => 'Contact Forms' ) );
} );

/** Enqueues the scripts (the real plugin's public function name). */
function wpcf7_enqueue_scripts() {
	wp_enqueue_script( 'contact-form-7', plugins_url( 'includes/js/index.js', __FILE__ ), array(), WPCF7_VERSION, true );
	wp_add_inline_script( 'contact-form-7', 'var wpcf7 = {"api":{"root":"' . esc_url_raw( rest_url() ) . '"}};', 'before' );
}

/** Enqueues the styles (the real plugin's public function name). */
function wpcf7_enqueue_styles() {
	wp_enqueue_style( 'contact-form-7', plugins_url( 'includes/css/styles.css', __FILE__ ), array(), WPCF7_VERSION );
}

// PLANTED WPF-06, CSS-09: assets on every page unless the filters say otherwise (same default as the real plugin).
add_action( 'wp_enqueue_scripts', function () {
	if ( apply_filters( 'wpcf7_load_js', true ) ) {
		wpcf7_enqueue_scripts();
	}
	if ( apply_filters( 'wpcf7_load_css', true ) ) {
		wpcf7_enqueue_styles();
	}
} );

add_shortcode( 'contact-form-7', function ( $atts ) {
	$id = isset( $atts['id'] ) ? (int) $atts['id'] : 0;
	return '<form class="wpcf7-form" method="post" action="#wpcf7-f' . $id . '" novalidate>'
		. '<p><label>Name <input type="text" name="your-name" required></label></p>'
		. '<p><label>Email <input type="email" name="your-email" required></label></p>'
		. '<p><label>Message <textarea name="your-message"></textarea></label></p>'
		. '<p><input type="submit" value="Send" class="wpcf7-submit"></p>'
		. '<div class="wpcf7-response-output" aria-hidden="true"></div></form>';
} );
