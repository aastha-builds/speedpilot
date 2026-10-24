<?php
/**
 * Plugin Name: Elementor (SpeedPilot stand-in)
 * Description: Sandbox stand-in with Elementor's slug, frontend handles and the feature options SpeedPilot reads. Written from scratch.
 * Version: 3.30-standin
 *
 * @package speedpilot-fixture
 */

defined( 'ABSPATH' ) || exit;

define( 'ELEMENTOR_VERSION', '3.30-standin' );

add_action( 'wp_enqueue_scripts', function () {
	wp_enqueue_style( 'elementor-frontend', plugins_url( 'assets/css/frontend.css', __FILE__ ), array(), ELEMENTOR_VERSION );
	wp_enqueue_script( 'elementor-frontend', plugins_url( 'assets/js/frontend.js', __FILE__ ), array( 'jquery' ), ELEMENTOR_VERSION, true );
	wp_add_inline_script( 'elementor-frontend', 'var elementorFrontendConfig = {"version":"' . ELEMENTOR_VERSION . '","experimentalFeatures":{}};', 'before' );
} );

register_activation_hook( __FILE__, function () {
	add_option( 'elementor_css_print_method', 'internal' );
	add_option( 'elementor_font_awesome_support', 'yes' );
	add_option( 'elementor_google_font', '1' );
	add_option( 'elementor_experiment-e_optimized_markup', 'default' );
	add_option( 'elementor_experiment-e_font_icon_svg', 'default' );
} );
