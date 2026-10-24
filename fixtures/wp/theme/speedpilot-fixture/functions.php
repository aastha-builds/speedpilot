<?php
/**
 * SpeedPilot fixture theme. Planted problems are marked PLANTED with their CHECKS.md IDs.
 *
 * @package speedpilot-fixture
 */

defined( 'ABSPATH' ) || exit;

require_once __DIR__ . '/inc/slow-query.php';

add_action( 'after_setup_theme', function () {
	add_theme_support( 'title-tag' );
	add_theme_support( 'post-thumbnails' );
	add_theme_support( 'woocommerce' );
	register_nav_menus( array( 'primary' => 'Primary' ) );
} );

add_action( 'wp_enqueue_scripts', function () {
	$uri = get_template_directory_uri();
	$ver = '1.0.0';

	// PLANTED FONT-01, FONT-02: Google Fonts with 6 weights from Google servers.
	wp_enqueue_style( 'spf-google-fonts', 'https://fonts.googleapis.com/css2?family=Roboto:ital,wght@0,300;0,400;0,500;0,700;0,900;1,400&display=swap', array(), null );
	wp_enqueue_style( 'spf-theme', $uri . '/assets/css/theme.css', array(), $ver );

	// PLANTED JS-01, DOC-05, JS-08: render-blocking scripts in head (jQuery and a slider library, no defer).
	wp_enqueue_script( 'jquery' );
	wp_enqueue_script( 'spf-legacy-slider', $uri . '/assets/js/legacy-slider.js', array( 'jquery' ), $ver, false );

	// PLANTED SAFE-01: an inline script that depends on jQuery right after it, in the head.
	wp_add_inline_script( 'spf-legacy-slider', 'jQuery(function($){ $(".hero").addClass("hero-ready"); window.spfSliderReady = typeof $.fn.spfSlider === "function"; });' );

	// Footer scripts: entrance animation, preloader, menu, heavy click handler.
	wp_enqueue_script( 'spf-animate', $uri . '/assets/js/animate.js', array(), $ver, true );
	wp_enqueue_script( 'spf-menu', $uri . '/assets/js/menu.js', array(), $ver, true );
	// PLANTED JS-04, REV-07: a click handler that blocks the main thread for about 300 ms.
	wp_enqueue_script( 'spf-heavy-click', $uri . '/assets/js/heavy-click.js', array(), $ver, true );
	// A script that is safe to defer: no dependents, runs on DOMContentLoaded only.
	wp_enqueue_script( 'spf-footer-year', $uri . '/assets/js/footer-year.js', array(), $ver, false );
	// An unused library: loaded everywhere, never called (JS-02, REV-02).
	wp_enqueue_script( 'spf-unused-lib', $uri . '/assets/js/unused-lib.js', array(), $ver, true );

	// PLANTED 3P-04: a chat widget loaded on page load from a third-party origin.
	$tp = defined( 'SPEEDPILOT_FIXTURE_THIRDPARTY' ) ? SPEEDPILOT_FIXTURE_THIRDPARTY : 'http://127.0.0.1:8890';
	wp_enqueue_script( 'spf-chat-widget', $tp . '/chat/widget.js', array(), null, true );
	// Analytics base tag (for the tracking guard). Beacons go to <thirdparty>/g/collect.
	wp_enqueue_script( 'spf-analytics', $tp . '/analytics/gtag.js', array(), null, false );
	wp_script_add_data( 'spf-analytics', 'strategy', 'async' );
} );

// PLANTED IMG-01, WPF-15: make the hero lazy by forcing loading="lazy" on every content image, including the first.
add_filter( 'wp_omit_loading_attr_threshold', function () {
	return 0;
} );

/** Hero markup: lazy, no fetchpriority (IMG-01), no width/height (IMG-06), entrance animation (DOC-04). */
function spf_hero() {
	$src = get_template_directory_uri() . '/assets/img/hero.jpg';
	echo '<section class="hero animate-in"><img src="' . esc_url( $src ) . '" alt="Fixture hero" loading="lazy" class="hero-img"><h1>Fast shop, slow fixture</h1></section>';
}

/** Gallery: unsized images (IMG-06, CLS-01) and eager offscreen images (IMG-07). */
function spf_gallery() {
	$base = get_template_directory_uri() . '/assets/img/';
	echo '<div class="gallery">';
	for ( $i = 1; $i <= 6; $i++ ) {
		echo '<img src="' . esc_url( $base . 'thumb-' . $i . '.jpg' ) . '" alt="Gallery ' . (int) $i . '">';
	}
	echo '</div>';
}

/** PLANTED VID-02: a YouTube embed without a facade. */
function spf_youtube() {
	echo '<div class="video"><iframe width="560" height="315" src="https://www.youtube-nocookie.com/embed/aqz-KE-bpKQ" title="Video" allowfullscreen></iframe></div>';
}

/** PLANTED CLS-03: a promo bar injected after load without reserved space. */
add_action( 'wp_footer', function () {
	echo '<script>addEventListener("load",function(){var b=document.createElement("div");b.className="promo-banner";b.textContent="Free shipping this week";document.body.insertBefore(b,document.body.firstChild);});</script>';
}, 99 );

// PLANTED WPF-07, WPB-16: WooCommerce cart fragments on every page (WooCommerce 7.8+ no longer does this by default).
add_action( 'wp_enqueue_scripts', function () {
	if ( wp_script_is( 'wc-cart-fragments', 'registered' ) ) {
		wp_enqueue_script( 'wc-cart-fragments' );
	}
}, 20 );
