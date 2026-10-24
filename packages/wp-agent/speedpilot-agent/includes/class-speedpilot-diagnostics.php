<?php
/**
 * Read-only diagnostics (SPEC.md 8.1): per-URL handle map, environment, autoload stats, cron list, Server-Timing for
 * token-authenticated requests, and on non-production environments only, slow queries and outgoing HTTP calls.
 * Everything here is inert for normal visitors.
 *
 * @package speedpilot-agent
 */

defined( 'ABSPATH' ) || exit;

/**
 * Diagnostics.
 */
class SpeedPilot_Diagnostics {

	/**
	 * Outgoing HTTP calls seen during this request.
	 *
	 * @var array
	 */
	private static $http = array();

	/**
	 * Is this front-end request a token-authenticated diagnostics request?
	 *
	 * @var bool
	 */
	private static $diag = false;

	/**
	 * Registers hooks. Cheap: two add_action calls for normal visitors.
	 */
	public static function boot() {
		add_action( 'rest_api_init', array( __CLASS__, 'routes' ) );
		add_action( 'wp_abilities_api_categories_init', array( __CLASS__, 'ability_category' ) );
		add_action( 'wp_abilities_api_init', array( __CLASS__, 'abilities' ) );

		if ( empty( $_SERVER['HTTP_X_SPEEDPILOT_TOKEN'] ) ) {
			return;
		}
		if ( ! SpeedPilot_Auth::token_valid( 'diag' ) ) {
			return;
		}
		self::$diag = true;

		// Staging-only instrumentation. Never on production (CLAUDE.md rule 12).
		if ( SpeedPilot_Auth::staging_diagnostics_allowed() ) {
			if ( ! defined( 'SAVEQUERIES' ) ) {
				define( 'SAVEQUERIES', true );
			}
			add_filter( 'pre_http_request', array( __CLASS__, 'http_before' ), PHP_INT_MAX, 3 );
			add_action( 'http_api_debug', array( __CLASS__, 'http_after' ), 10, 5 );
		}

		foreach ( array( 'plugins_loaded', 'after_setup_theme', 'init', 'wp_loaded', 'wp', 'template_redirect', 'wp_head', 'wp_footer' ) as $hook ) {
			add_action(
				$hook,
				function () use ( $hook ) {
					$GLOBALS['speedpilot_marks'][ $hook ] = microtime( true );
				},
				-PHP_INT_MAX
			);
		}
		add_action( 'template_redirect', array( __CLASS__, 'start_buffer' ), PHP_INT_MAX );
		add_action( 'wp_footer', array( __CLASS__, 'footer_report' ), PHP_INT_MAX );
	}

	/**
	 * REST routes.
	 */
	public static function routes() {
		$perm = array( 'SpeedPilot_Auth', 'rest_permission' );
		register_rest_route( 'speedpilot/v1', '/ping', array( 'methods' => 'GET', 'callback' => array( __CLASS__, 'ping' ), 'permission_callback' => $perm ) );
		register_rest_route( 'speedpilot/v1', '/env', array( 'methods' => 'GET', 'callback' => array( __CLASS__, 'environment' ), 'permission_callback' => $perm ) );
		register_rest_route( 'speedpilot/v1', '/autoload', array( 'methods' => 'GET', 'callback' => array( __CLASS__, 'autoload' ), 'permission_callback' => $perm ) );
		register_rest_route( 'speedpilot/v1', '/cron', array( 'methods' => 'GET', 'callback' => array( __CLASS__, 'cron' ), 'permission_callback' => $perm ) );
		register_rest_route( 'speedpilot/v1', '/flags', array( 'methods' => 'GET', 'callback' => array( __CLASS__, 'flags' ), 'permission_callback' => $perm ) );
	}

	/**
	 * Ping.
	 *
	 * @return array
	 */
	public static function ping() {
		return array(
			'agent'    => SPEEDPILOT_AGENT_VERSION,
			'disabled' => false,
		);
	}

	/**
	 * Environment info (SPEC.md 3.9).
	 *
	 * @return array
	 */
	public static function environment() {
		global $wpdb, $wp_version;
		$opcache = function_exists( 'opcache_get_status' ) ? @opcache_get_status( false ) : false; // phpcs:ignore WordPress.PHP.NoSilencedErrors
		$dropins = array();
		foreach ( array( 'object-cache.php', 'advanced-cache.php', 'db.php', 'sunrise.php' ) as $f ) {
			$dropins[ $f ] = file_exists( WP_CONTENT_DIR . '/' . $f );
		}
		return array(
			'wordpress'         => $wp_version,
			'php'               => PHP_VERSION,
			'sapi'              => PHP_SAPI,
			'db'                => method_exists( $wpdb, 'db_server_info' ) ? $wpdb->db_server_info() : $wpdb->db_version(),
			'server'            => isset( $_SERVER['SERVER_SOFTWARE'] ) ? sanitize_text_field( wp_unslash( $_SERVER['SERVER_SOFTWARE'] ) ) : null,
			'memory_limit'      => ini_get( 'memory_limit' ),
			'max_execution'     => ini_get( 'max_execution_time' ),
			'opcache'           => $opcache ? array(
				'enabled'  => ! empty( $opcache['opcache_enabled'] ),
				'used_mb'  => isset( $opcache['memory_usage']['used_memory'] ) ? round( $opcache['memory_usage']['used_memory'] / 1048576, 1 ) : null,
				'free_mb'  => isset( $opcache['memory_usage']['free_memory'] ) ? round( $opcache['memory_usage']['free_memory'] / 1048576, 1 ) : null,
				'hit_rate' => isset( $opcache['opcache_statistics']['opcache_hit_rate'] ) ? round( $opcache['opcache_statistics']['opcache_hit_rate'], 1 ) : null,
			) : null,
			'xdebug'            => extension_loaded( 'xdebug' ),
			'wp_debug'          => defined( 'WP_DEBUG' ) && WP_DEBUG,
			'wp_debug_log'      => defined( 'WP_DEBUG_LOG' ) && WP_DEBUG_LOG,
			'wp_debug_display'  => defined( 'WP_DEBUG_DISPLAY' ) ? (bool) WP_DEBUG_DISPLAY : true,
			'savequeries'       => defined( 'SAVEQUERIES' ) && SAVEQUERIES && ! self::$diag,
			'script_debug'      => defined( 'SCRIPT_DEBUG' ) && SCRIPT_DEBUG,
			'disable_wp_cron'   => defined( 'DISABLE_WP_CRON' ) && DISABLE_WP_CRON,
			'alternate_wp_cron' => defined( 'ALTERNATE_WP_CRON' ) && ALTERNATE_WP_CRON,
			'multisite'         => is_multisite(),
			'environment_type'  => function_exists( 'wp_get_environment_type' ) ? wp_get_environment_type() : null,
			'dropins'           => $dropins,
			'object_cache'      => wp_using_ext_object_cache(),
			'active_plugins'    => array_values( (array) get_option( 'active_plugins', array() ) ),
			'mu_plugins'        => array_keys( get_mu_plugins() ),
			'theme'             => get_stylesheet(),
			'parent_theme'      => get_template(),
			'abilities_api'     => function_exists( 'wp_register_ability' ),
		);
	}

	/**
	 * Autoloaded options total and the 20 largest with their likely owner (SPEC.md 3.9).
	 *
	 * @return array
	 */
	public static function autoload() {
		global $wpdb;
		$autoload_values = function_exists( 'wp_autoload_values_to_autoload' ) ? wp_autoload_values_to_autoload() : array( 'yes', 'on', 'auto-on', 'auto' );
		$in              = implode( ',', array_fill( 0, count( $autoload_values ), '%s' ) );
		// phpcs:disable WordPress.DB.PreparedSQLPlaceholders, WordPress.DB.DirectDatabaseQuery, WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		$total = (int) $wpdb->get_var( $wpdb->prepare( "SELECT SUM(LENGTH(option_value)) FROM {$wpdb->options} WHERE autoload IN ($in)", $autoload_values ) );
		$count = (int) $wpdb->get_var( $wpdb->prepare( "SELECT COUNT(*) FROM {$wpdb->options} WHERE autoload IN ($in)", $autoload_values ) );
		$rows  = $wpdb->get_results( $wpdb->prepare( "SELECT option_name, LENGTH(option_value) AS bytes FROM {$wpdb->options} WHERE autoload IN ($in) ORDER BY bytes DESC LIMIT 20", $autoload_values ), ARRAY_A );
		$expired = (int) $wpdb->get_var( $wpdb->prepare( "SELECT COUNT(*) FROM {$wpdb->options} WHERE option_name LIKE %s AND option_value < %d", $wpdb->esc_like( '_transient_timeout_' ) . '%', time() ) );
		// phpcs:enable
		$top = array();
		foreach ( (array) $rows as $r ) {
			$top[] = array(
				'name'  => $r['option_name'],
				'bytes' => (int) $r['bytes'],
				'owner' => self::option_owner( $r['option_name'] ),
			);
		}
		return array(
			'total_bytes'        => $total,
			'count'              => $count,
			'top'                => $top,
			'expired_transients' => $expired,
		);
	}

	/**
	 * Guesses an option's owner by name prefix against active plugins and the theme.
	 *
	 * @param string $name Option name.
	 * @return string
	 */
	public static function option_owner( $name ) {
		$core = array( 'siteurl', 'home', 'blogname', 'cron', 'rewrite_rules', 'active_plugins', 'sidebars_widgets', 'widget_', 'theme_mods_', 'wp_user_roles', 'recently_edited', '_transient_', '_site_transient_', 'can_compress_scripts', 'uninstall_plugins' );
		foreach ( $core as $c ) {
			if ( 0 === strpos( $name, $c ) ) {
				return 'core:wordpress';
			}
		}
		$known = array(
			'woocommerce' => 'plugin:woocommerce',
			'wc_'         => 'plugin:woocommerce',
			'_wc_'        => 'plugin:woocommerce',
			'elementor'   => 'plugin:elementor',
			'wpcf7'       => 'plugin:contact-form-7',
			'smartslider' => 'plugin:smart-slider-3',
			'n2_'         => 'plugin:smart-slider-3',
			'wpseo'       => 'plugin:wordpress-seo',
			'rank_math'   => 'plugin:seo-by-rank-math',
			'jetpack'     => 'plugin:jetpack',
			'action_scheduler' => 'plugin:woocommerce',
			'speedpilot'  => 'mu-plugin:speedpilot-agent',
		);
		foreach ( $known as $prefix => $owner ) {
			if ( 0 === strpos( $name, $prefix ) ) {
				return $owner;
			}
		}
		$theme = get_stylesheet();
		if ( 0 === strpos( $name, str_replace( '-', '_', $theme ) ) ) {
			return 'theme:' . $theme;
		}
		foreach ( (array) get_option( 'active_plugins', array() ) as $file ) {
			$slug = dirname( $file );
			$norm = str_replace( '-', '_', $slug );
			if ( '.' !== $slug && ( 0 === strpos( $name, $slug ) || 0 === strpos( $name, $norm ) ) ) {
				return 'plugin:' . $slug;
			}
		}
		$prefix = strtok( $name, '_' );
		return 'unknown:' . $prefix . ' (no active plugin matches; maybe a removed plugin)';
	}

	/**
	 * Cron events with schedule and next run (SPEC.md 3.9).
	 *
	 * @return array
	 */
	public static function cron() {
		$out  = array();
		$now  = time();
		$cron = _get_cron_array();
		foreach ( (array) $cron as $ts => $hooks ) {
			foreach ( (array) $hooks as $hook => $events ) {
				foreach ( (array) $events as $e ) {
					$out[] = array(
						'hook'     => $hook,
						'next'     => (int) $ts,
						'overdue'  => $ts < $now - 600,
						'schedule' => isset( $e['schedule'] ) ? $e['schedule'] : false,
						'interval' => isset( $e['interval'] ) ? (int) $e['interval'] : null,
					);
				}
			}
		}
		return array(
			'events'          => $out,
			'disable_wp_cron' => defined( 'DISABLE_WP_CRON' ) && DISABLE_WP_CRON,
		);
	}

	/**
	 * Current flags (read-only).
	 *
	 * @return array
	 */
	public static function flags() {
		return SpeedPilot_Flags::all();
	}

	/**
	 * Observes outgoing HTTP calls; never changes them.
	 *
	 * @param false|array $pre  Short-circuit value.
	 * @param array       $args Request args.
	 * @param string      $url  URL.
	 * @return false|array
	 */
	public static function http_before( $pre, $args, $url ) {
		self::$http[] = array(
			'url'    => preg_replace( '/([?&](key|token|password|secret)=)[^&]+/i', '$1[REDACTED]', $url ),
			'start'  => microtime( true ),
			'caller' => self::caller(),
		);
		return $pre;
	}

	/**
	 * Records the end of an outgoing HTTP call.
	 *
	 * @param mixed  $response Response.
	 * @param string $context  Context.
	 * @param string $class    Transport class.
	 * @param array  $args     Args.
	 * @param string $url      URL.
	 */
	public static function http_after( $response, $context, $class, $args, $url ) {
		$n = count( self::$http );
		if ( $n ) {
			self::$http[ $n - 1 ]['ms'] = round( ( microtime( true ) - self::$http[ $n - 1 ]['start'] ) * 1000, 1 );
		}
	}

	/**
	 * First caller outside WordPress core and this agent, as "owner:file:function".
	 *
	 * @return string
	 */
	private static function caller() {
		$trace = debug_backtrace( DEBUG_BACKTRACE_IGNORE_ARGS, 30 ); // phpcs:ignore WordPress.PHP.DevelopmentFunctions
		foreach ( $trace as $f ) {
			if ( empty( $f['file'] ) ) {
				continue;
			}
			$file = wp_normalize_path( $f['file'] );
			if ( false !== strpos( $file, '/wp-includes/' ) || false !== strpos( $file, '/speedpilot-agent/' ) ) {
				continue;
			}
			return self::owner_of_file( $file ) . ':' . basename( $file ) . ':' . ( isset( $f['function'] ) ? $f['function'] : '' );
		}
		return 'unknown';
	}

	/**
	 * Owner of a PHP file.
	 *
	 * @param string $file Path.
	 * @return string
	 */
	public static function owner_of_file( $file ) {
		$file = wp_normalize_path( $file );
		if ( preg_match( '#/plugins/([^/]+)/#', $file, $m ) ) {
			return 'plugin:' . $m[1];
		}
		if ( preg_match( '#/themes/([^/]+)/#', $file, $m ) ) {
			return 'theme:' . $m[1];
		}
		if ( false !== strpos( $file, '/mu-plugins/' ) ) {
			return 'mu-plugin:' . basename( $file, '.php' );
		}
		return 'core:wordpress';
	}

	/**
	 * Buffers the page for token requests only, so Server-Timing can be sent with the full render time.
	 */
	public static function start_buffer() {
		ob_start();
		add_action( 'shutdown', array( __CLASS__, 'end_buffer' ), 0 );
	}

	/**
	 * Sends Server-Timing and flushes.
	 */
	public static function end_buffer() {
		$marks = $GLOBALS['speedpilot_marks'];
		$t0    = $GLOBALS['speedpilot_t0'];
		$parts = array();
		$prev  = $t0;
		foreach ( $marks as $name => $t ) {
			$parts[] = sprintf( 'sp-%s;dur=%.1f', str_replace( '_', '-', $name ), ( $t - $prev ) * 1000 );
			$prev    = $t;
		}
		$parts[] = sprintf( 'sp-total;dur=%.1f', ( microtime( true ) - $t0 ) * 1000 );
		if ( ! headers_sent() ) {
			header( 'Server-Timing: ' . implode( ', ', $parts ), false );
		}
		while ( ob_get_level() > 0 ) {
			ob_end_flush();
		}
	}

	/**
	 * Prints the diagnostics report as an HTML comment at the very end of wp_footer (after footer scripts printed).
	 */
	public static function footer_report() {
		global $wp_scripts, $wp_styles, $wpdb;
		$report = array(
			'agent'    => SPEEDPILOT_AGENT_VERSION,
			'template' => SpeedPilot_Flags::template(),
			'scripts'  => self::handles( $wp_scripts, 'script' ),
			'styles'   => self::handles( $wp_styles, 'style' ),
			'queries'  => array(),
			'http'     => array(),
			'flags'    => array_keys( array_filter( (array) SpeedPilot_Flags::all()['modules'], function ( $m ) {
				return ! empty( $m['enabled'] );
			} ) ),
		);
		if ( SpeedPilot_Auth::staging_diagnostics_allowed() && ! empty( $wpdb->queries ) ) {
			$total = 0;
			foreach ( $wpdb->queries as $q ) {
				$ms     = isset( $q[1] ) ? $q[1] * 1000 : 0;
				$total += $ms;
				if ( $ms < 5 ) {
					continue;
				}
				$stack  = isset( $q[2] ) ? (string) $q[2] : '';
				$frames = array_map( 'trim', explode( ',', $stack ) );
				$report['queries'][] = array(
					'ms'     => round( $ms, 1 ),
					'sql'    => substr( preg_replace( '/\s+/', ' ', $q[0] ), 0, 300 ),
					'caller' => self::query_caller( $frames ),
					'stack'  => array_slice( $frames, -6 ),
				);
			}
			$report['query_count']    = count( $wpdb->queries );
			$report['query_total_ms'] = round( $total, 1 );
			foreach ( self::$http as $h ) {
				unset( $h['start'] );
				$report['http'][] = $h;
			}
		}
		echo "\n<!-- speedpilot-diag:" . base64_encode( wp_json_encode( $report ) ) . " -->\n"; // phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions, WordPress.Security.EscapeOutput
	}

	/**
	 * The innermost non-core function in a SAVEQUERIES stack, with an owner guess.
	 *
	 * @param array $frames Stack frames, outermost first.
	 * @return array
	 */
	private static function query_caller( $frames ) {
		$core = array( 'require', 'require_once', 'include', 'include_once', 'do_action', 'apply_filters', 'WP_Hook->', 'WP_Query->', 'WP->', 'wpdb->', 'get_', 'wp_', 'WC_', 'update_', 'do_shortcode', 'call_user_func', 'the_', 'have_posts', 'locate_template', 'load_template', 'get_header', 'get_footer', 'get_template_part' );
		for ( $i = count( $frames ) - 1; $i >= 0; $i-- ) {
			$f      = $frames[ $i ];
			$skip   = false;
			foreach ( $core as $c ) {
				if ( 0 === strpos( $f, $c ) ) {
					$skip = true;
					break;
				}
			}
			if ( ! $skip && '' !== $f ) {
				$fn    = preg_replace( '/\(.*$/', '', $f );
				$owner = 'unknown';
				if ( function_exists( $fn ) ) {
					try {
						$ref   = new ReflectionFunction( $fn );
						$owner = self::owner_of_file( (string) $ref->getFileName() ) . ':' . basename( (string) $ref->getFileName() );
					} catch ( ReflectionException $e ) {
						$owner = 'unknown';
					}
				}
				return array( 'function' => $fn, 'owner' => $owner );
			}
		}
		return array( 'function' => 'unknown', 'owner' => 'unknown' );
	}

	/**
	 * Enqueued handles with source, version, deps, strategy, position and attached inline code.
	 *
	 * @param WP_Dependencies|null $deps Scripts or styles.
	 * @param string               $type script|style.
	 * @return array
	 */
	private static function handles( $deps, $type ) {
		if ( ! $deps ) {
			return array();
		}
		$out = array();
		foreach ( (array) $deps->done as $handle ) {
			if ( ! isset( $deps->registered[ $handle ] ) ) {
				continue;
			}
			$d   = $deps->registered[ $handle ];
			$src = $d->src;
			if ( $src && 0 !== strpos( $src, 'http' ) && 0 !== strpos( $src, '//' ) ) {
				$src = $deps->base_url . $src;
			}
			$row = array(
				'handle' => $handle,
				'src'    => $src ? $src : null,
				'ver'    => $d->ver,
				'deps'   => array_values( (array) $d->deps ),
				'owner'  => self::owner_of_src( $src ),
			);
			if ( 'script' === $type ) {
				$row['strategy'] = $deps->get_data( $handle, 'strategy' ) ? $deps->get_data( $handle, 'strategy' ) : null;
				$row['footer']   = 1 === (int) $deps->get_data( $handle, 'group' ) || in_array( $handle, (array) $deps->in_footer, true );
				$before          = $deps->get_data( $handle, 'before' );
				$after           = $deps->get_data( $handle, 'after' );
				$extra           = $deps->get_data( $handle, 'data' );
				$row['inline']   = array(
					'before' => $before ? array_map( array( __CLASS__, 'snip' ), (array) $before ) : array(),
					'after'  => $after ? array_map( array( __CLASS__, 'snip' ), (array) $after ) : array(),
					'data'   => $extra ? self::snip( (string) $extra ) : null,
					'data_bytes' => $extra ? strlen( (string) $extra ) : 0,
				);
			} else {
				$after         = $deps->get_data( $handle, 'after' );
				$row['media']  = $d->args;
				$row['inline'] = array( 'after' => $after ? array_map( array( __CLASS__, 'snip' ), (array) $after ) : array() );
			}
			$out[] = $row;
		}
		return $out;
	}

	/**
	 * Short inline code sample.
	 *
	 * @param string $code Code.
	 * @return string
	 */
	public static function snip( $code ) {
		$code = (string) $code;
		return strlen( $code ) > 2000 ? substr( $code, 0, 2000 ) . '/*...*/' : $code;
	}

	/**
	 * Owner of an asset URL.
	 *
	 * @param string|false $src Source.
	 * @return string
	 */
	public static function owner_of_src( $src ) {
		if ( ! $src ) {
			return 'inline';
		}
		if ( preg_match( '#/wp-content/plugins/([^/]+)/#', $src, $m ) ) {
			return 'plugin:' . $m[1];
		}
		if ( preg_match( '#/wp-content/themes/([^/]+)/#', $src, $m ) ) {
			return 'theme:' . $m[1];
		}
		if ( false !== strpos( $src, '/wp-includes/' ) || false !== strpos( $src, '/wp-admin/' ) ) {
			return 'core:wordpress';
		}
		$host = wp_parse_url( $src, PHP_URL_HOST );
		$home = wp_parse_url( home_url(), PHP_URL_HOST );
		return $host && $host !== $home ? 'third-party:' . $host : 'first-party';
	}

	/**
	 * Abilities API category (WordPress 6.9+).
	 */
	public static function ability_category() {
		if ( function_exists( 'wp_register_ability_category' ) ) {
			wp_register_ability_category( 'speedpilot', array( 'label' => 'SpeedPilot', 'description' => 'Read-only speed diagnostics.' ) );
		}
	}

	/**
	 * Registers the read-only diagnostics as Abilities so an MCP adapter can call them (WordPress 6.9+).
	 */
	public static function abilities() {
		if ( ! function_exists( 'wp_register_ability' ) ) {
			return;
		}
		$perm = function () {
			return current_user_can( 'manage_options' );
		};
		$defs = array(
			'speedpilot/environment' => array( 'Environment', 'PHP, database, OPcache, drop-ins and debug constants.', array( __CLASS__, 'environment' ) ),
			'speedpilot/autoload'    => array( 'Autoload stats', 'Autoloaded options total and the largest options with owners.', array( __CLASS__, 'autoload' ) ),
			'speedpilot/cron'        => array( 'Cron events', 'Scheduled events, overdue events and schedules.', array( __CLASS__, 'cron' ) ),
		);
		foreach ( $defs as $name => $d ) {
			wp_register_ability(
				$name,
				array(
					'label'               => $d[0],
					'description'         => $d[1],
					'category'            => 'speedpilot',
					'output_schema'       => array( 'type' => 'object' ),
					'execute_callback'    => $d[2],
					'permission_callback' => $perm,
					'meta'                => array( 'annotations' => array( 'readonly' => true ) ),
				)
			);
		}
	}
}
