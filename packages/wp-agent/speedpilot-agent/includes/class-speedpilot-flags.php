<?php
/**
 * Feature flags: one small autoloaded option (read from the alloptions cache, so zero extra queries),
 * versioned, exportable and importable. Every optimization module is one flag with per-template or per-URL rules.
 *
 * @package speedpilot-agent
 */

defined( 'ABSPATH' ) || exit;

/**
 * Flags store.
 */
class SpeedPilot_Flags {

	/**
	 * Cached flags for this request.
	 *
	 * @var array|null
	 */
	private static $cache = null;

	/**
	 * Returns the flags document.
	 *
	 * @return array
	 */
	public static function all() {
		if ( null !== self::$cache ) {
			return self::$cache;
		}
		$raw = get_option( SPEEDPILOT_FLAGS_OPTION, '' );
		$doc = is_string( $raw ) && '' !== $raw ? json_decode( $raw, true ) : ( is_array( $raw ) ? $raw : null );
		if ( ! is_array( $doc ) || ! isset( $doc['modules'] ) || ! is_array( $doc['modules'] ) ) {
			$doc = array(
				'version' => 0,
				'modules' => array(),
				'log'     => array(),
			);
		}
		self::$cache = $doc;
		return $doc;
	}

	/**
	 * Is a module enabled for the current request?
	 *
	 * @param string $key Module key.
	 * @return bool
	 */
	public static function enabled( $key ) {
		if ( self::bypassed() ) {
			return false;
		}
		$doc = self::all();
		if ( empty( $doc['modules'][ $key ]['enabled'] ) ) {
			return false;
		}
		return self::rules_match( isset( $doc['modules'][ $key ]['rules'] ) ? $doc['modules'][ $key ]['rules'] : array() );
	}

	/**
	 * Settings of a module.
	 *
	 * @param string $key Module key.
	 * @return array
	 */
	public static function settings( $key ) {
		$doc = self::all();
		return isset( $doc['modules'][ $key ]['settings'] ) && is_array( $doc['modules'][ $key ]['settings'] ) ? $doc['modules'][ $key ]['settings'] : array();
	}

	/**
	 * Logged-in admins can compare with ?speedpilot=off. Never works for the public.
	 *
	 * @return bool
	 */
	public static function bypassed() {
		// phpcs:ignore WordPress.Security.NonceVerification.Recommended
		if ( ! isset( $_GET['speedpilot'] ) || 'off' !== $_GET['speedpilot'] ) {
			return false;
		}
		return function_exists( 'current_user_can' ) && did_action( 'set_current_user' ) && current_user_can( 'manage_options' );
	}

	/**
	 * Matches per-template and per-URL rules. Empty rules match everything.
	 *
	 * @param array $rules Rules: templates[], urls[] (path prefixes), exclude[] (path prefixes).
	 * @return bool
	 */
	public static function rules_match( $rules ) {
		$path = isset( $_SERVER['REQUEST_URI'] ) ? (string) wp_parse_url( wp_unslash( $_SERVER['REQUEST_URI'] ), PHP_URL_PATH ) : '/'; // phpcs:ignore WordPress.Security.ValidatedSanitizedInput
		if ( ! empty( $rules['exclude'] ) ) {
			foreach ( (array) $rules['exclude'] as $prefix ) {
				if ( '' !== $prefix && 0 === strpos( $path, $prefix ) ) {
					return false;
				}
			}
		}
		if ( ! empty( $rules['urls'] ) ) {
			$hit = false;
			foreach ( (array) $rules['urls'] as $prefix ) {
				if ( $path === $prefix || ( '/' !== $prefix && 0 === strpos( $path, rtrim( $prefix, '*' ) ) && '*' === substr( $prefix, -1 ) ) ) {
					$hit = true;
				}
			}
			if ( ! $hit ) {
				return false;
			}
		}
		if ( ! empty( $rules['templates'] ) && did_action( 'wp' ) ) {
			return in_array( self::template(), (array) $rules['templates'], true );
		}
		return true;
	}

	/**
	 * Template type of the current request, matching SpeedPilot's classification.
	 *
	 * @return string
	 */
	public static function template() {
		if ( is_front_page() ) {
			return 'home';
		}
		if ( function_exists( 'is_product' ) && is_product() ) {
			return 'product';
		}
		if ( function_exists( 'is_shop' ) && is_shop() ) {
			return 'shop';
		}
		if ( function_exists( 'is_product_taxonomy' ) && is_product_taxonomy() ) {
			return 'collection';
		}
		if ( function_exists( 'is_cart' ) && is_cart() ) {
			return 'cart';
		}
		if ( function_exists( 'is_checkout' ) && is_checkout() ) {
			return 'checkout';
		}
		if ( function_exists( 'is_account_page' ) && is_account_page() ) {
			return 'account';
		}
		if ( is_search() ) {
			return 'search';
		}
		if ( is_404() ) {
			return '404';
		}
		if ( is_home() ) {
			return 'blog';
		}
		if ( is_singular( 'post' ) ) {
			return 'post';
		}
		if ( is_archive() ) {
			return 'archive';
		}
		if ( is_page() ) {
			$slug = get_post_field( 'post_name', get_queried_object_id() );
			return 'contact' === $slug ? 'contact' : 'page';
		}
		return 'page';
	}

	/**
	 * Replaces the flags document (used by import and by SpeedPilot's executor through WP-CLI).
	 *
	 * @param array  $doc    Flags document.
	 * @param string $reason Change log line.
	 * @return array
	 */
	public static function save( $doc, $reason = '' ) {
		$prev           = self::all();
		$doc['version'] = isset( $prev['version'] ) ? (int) $prev['version'] + 1 : 1;
		$log            = isset( $prev['log'] ) && is_array( $prev['log'] ) ? $prev['log'] : array();
		$log[]          = array(
			'version' => $doc['version'],
			'time'    => gmdate( 'c' ),
			'reason'  => (string) $reason,
		);
		$doc['log']     = array_slice( $log, -50 );
		update_option( SPEEDPILOT_FLAGS_OPTION, wp_json_encode( $doc ), true );
		self::$cache = $doc;
		return $doc;
	}

	/**
	 * Clears the request cache (tests).
	 */
	public static function reset_cache() {
		self::$cache = null;
	}
}
