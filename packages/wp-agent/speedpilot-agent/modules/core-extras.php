<?php
/**
 * Module core-extras (SPEC.md 8.1, WPF-02, JS-07): emoji script, oEmbed discovery and wp-embed, dashicons for
 * logged-out visitors, jQuery Migrate (only with zero migrate warnings across all flows), block library CSS on pages
 * without blocks, Heartbeat (front end off when unused, admin interval 60 s, never off in the editor), comment-reply
 * only where comments are open. Each part is its own setting.
 *
 * Settings: emoji, oembed, dashicons, jqueryMigrate, blockCss, heartbeat, commentReply (booleans).
 *
 * @package speedpilot-agent
 */

defined( 'ABSPATH' ) || exit;

$speedpilot_ce = SpeedPilot_Flags::settings( 'core-extras' );
$speedpilot_on = function ( $key ) use ( $speedpilot_ce ) {
	return ! empty( $speedpilot_ce[ $key ] ) && SpeedPilot_Flags::enabled( 'core-extras' );
};

add_action(
	'init',
	function () use ( $speedpilot_on ) {
		if ( is_admin() ) {
			return;
		}
		if ( $speedpilot_on( 'emoji' ) ) {
			remove_action( 'wp_head', 'print_emoji_detection_script', 7 );
			remove_action( 'wp_print_styles', 'print_emoji_styles' );
			remove_action( 'wp_enqueue_scripts', 'wp_enqueue_emoji_styles' );
			remove_filter( 'the_content_feed', 'wp_staticize_emoji' );
			remove_filter( 'comment_text_rss', 'wp_staticize_emoji' );
		}
		if ( $speedpilot_on( 'oembed' ) ) {
			remove_action( 'wp_head', 'wp_oembed_add_discovery_links' );
			remove_action( 'wp_head', 'wp_oembed_add_host_js' );
		}
	},
	1
);

add_action(
	'wp_default_scripts',
	function ( $scripts ) use ( $speedpilot_on ) {
		if ( is_admin() || ! $speedpilot_on( 'jqueryMigrate' ) || empty( $scripts->registered['jquery'] ) ) {
			return;
		}
		$scripts->registered['jquery']->deps = array_values( array_diff( $scripts->registered['jquery']->deps, array( 'jquery-migrate' ) ) );
	}
);

add_action(
	'wp_enqueue_scripts',
	function () use ( $speedpilot_on ) {
		if ( $speedpilot_on( 'dashicons' ) && ! is_user_logged_in() && ! is_admin_bar_showing() ) {
			wp_dequeue_style( 'dashicons' );
		}
		if ( $speedpilot_on( 'oembed' ) ) {
			wp_dequeue_script( 'wp-embed' );
		}
		if ( $speedpilot_on( 'blockCss' ) && is_singular() && ! has_blocks( get_queried_object_id() ) ) {
			wp_dequeue_style( 'wp-block-library' );
			wp_dequeue_style( 'wp-block-library-theme' );
			wp_dequeue_style( 'global-styles' );
			wp_dequeue_style( 'classic-theme-styles' );
		}
		if ( $speedpilot_on( 'commentReply' ) && ! ( is_singular() && comments_open() && get_option( 'thread_comments' ) ) ) {
			wp_dequeue_script( 'comment-reply' );
		}
		if ( $speedpilot_on( 'heartbeat' ) && ! is_admin() ) {
			wp_deregister_script( 'heartbeat' );
		}
	},
	9999
);

add_filter(
	'heartbeat_settings',
	function ( $settings ) use ( $speedpilot_on ) {
		if ( $speedpilot_on( 'heartbeat' ) && is_admin() ) {
			$screen = function_exists( 'get_current_screen' ) ? get_current_screen() : null;
			// never slow down the editor's autosave and post locking
			if ( ! $screen || 'post' !== $screen->base ) {
				$settings['interval'] = 60;
			}
		}
		return $settings;
	}
);
