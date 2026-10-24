<?php
/**
 * One shared HTML rewrite pass for the modules that need it (LCP, images, facades). On WordPress 6.9+ it hooks the
 * template enhancement output buffer (`wp_template_enhancement_output_buffer`) so it does not fight other plugins'
 * buffers; on older versions it opens the smallest possible buffer on template_redirect. Tags are edited with
 * WP_HTML_Tag_Processor, never with regular expressions over the page.
 *
 * @package speedpilot-agent
 */

defined( 'ABSPATH' ) || exit;

/**
 * HTML processor registry.
 */
class SpeedPilot_Html {

	/**
	 * Registered processors: priority => list of callables receiving the HTML and returning HTML.
	 *
	 * @var array
	 */
	private static $processors = array();

	/**
	 * Whether the buffer hook is in place.
	 *
	 * @var bool
	 */
	private static $hooked = false;

	/**
	 * Registers a processor.
	 *
	 * @param callable $fn       Receives and returns the full HTML document.
	 * @param int      $priority Lower runs first.
	 */
	public static function add( $fn, $priority = 10 ) {
		self::$processors[ $priority ][] = $fn;
		if ( self::$hooked ) {
			return;
		}
		self::$hooked = true;
		if ( function_exists( 'wp_start_template_enhancement_output_buffer' ) ) {
			add_filter( 'wp_template_enhancement_output_buffer', array( __CLASS__, 'process' ), 20 );
		} else {
			add_action( 'template_redirect', array( __CLASS__, 'start_buffer' ), 1000 );
		}
	}

	/**
	 * Fallback buffer for WordPress before 6.9.
	 */
	public static function start_buffer() {
		if ( ! self::is_html_request() ) {
			return;
		}
		ob_start( array( __CLASS__, 'process' ) );
	}

	/**
	 * Front-end HTML GET requests only.
	 *
	 * @return bool
	 */
	public static function is_html_request() {
		if ( is_admin() || wp_doing_ajax() || ( defined( 'REST_REQUEST' ) && REST_REQUEST ) || is_feed() || is_embed() || ( function_exists( 'wp_is_json_request' ) && wp_is_json_request() ) ) {
			return false;
		}
		$method = isset( $_SERVER['REQUEST_METHOD'] ) ? strtoupper( sanitize_text_field( wp_unslash( $_SERVER['REQUEST_METHOD'] ) ) ) : 'GET';
		return 'GET' === $method || 'HEAD' === $method;
	}

	/**
	 * Runs the processors over the document.
	 *
	 * @param string $html Document.
	 * @return string
	 */
	public static function process( $html ) {
		if ( ! is_string( $html ) || false === stripos( substr( $html, 0, 1000 ), '<html' ) || ! self::is_html_request() ) {
			return $html;
		}
		ksort( self::$processors );
		foreach ( self::$processors as $list ) {
			foreach ( $list as $fn ) {
				$out = call_user_func( $fn, $html );
				if ( is_string( $out ) && '' !== $out ) {
					$html = $out;
				}
			}
		}
		return $html;
	}

	/**
	 * Clears processors (tests).
	 */
	public static function reset() {
		self::$processors = array();
	}

	/**
	 * Applies processors to a string outside a request (tests and the overhead benchmark).
	 *
	 * @param string $html Document.
	 * @return string
	 */
	public static function apply( $html ) {
		ksort( self::$processors );
		foreach ( self::$processors as $list ) {
			foreach ( $list as $fn ) {
				$out = call_user_func( $fn, $html );
				if ( is_string( $out ) && '' !== $out ) {
					$html = $out;
				}
			}
		}
		return $html;
	}
}
