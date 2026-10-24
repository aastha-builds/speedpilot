<?php
/**
 * Plugin Name: Smart Slider 3 (SpeedPilot stand-in)
 * Description: Sandbox stand-in with the same slug and shortcode as Smart Slider 3. Loads its assets on every page and every slide eagerly. Written from scratch.
 * Version: 3.5-standin
 *
 * @package speedpilot-fixture
 */

defined( 'ABSPATH' ) || exit;

// PLANTED WPF-11, IMG-10: slider assets on every page.
add_action( 'wp_enqueue_scripts', function () {
	wp_enqueue_style( 'smartslider', plugins_url( 'assets/smartslider.css', __FILE__ ), array(), '3.5' );
	wp_enqueue_script( 'smartslider-frontend', plugins_url( 'assets/smartslider.js', __FILE__ ), array(), '3.5', false );
} );

add_shortcode( 'smartslider3', function () {
	$base = get_template_directory_uri() . '/assets/img/';
	$out  = '<div class="n2-ss-slider" data-ss="1">';
	for ( $i = 1; $i <= 4; $i++ ) {
		// every slide eager, no sizes
		$out .= '<div class="n2-ss-slide' . ( 1 === $i ? ' n2-active' : '' ) . '"><img src="' . esc_url( $base . 'thumb-' . $i . '.jpg' ) . '" alt="Slide ' . $i . '"></div>';
	}
	return $out . '<button class="n2-next" type="button" aria-label="Next">&rsaquo;</button></div>';
} );
