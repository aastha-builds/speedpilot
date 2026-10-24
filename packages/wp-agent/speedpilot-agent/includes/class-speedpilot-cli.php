<?php
/**
 * `wp speedpilot ...`: flag management for SpeedPilot's executor. Each change is one flag and is logged.
 *
 * @package speedpilot-agent
 */

defined( 'ABSPATH' ) || exit;

/**
 * Manages SpeedPilot flags.
 */
class SpeedPilot_CLI {

	/**
	 * Prints the flags document as JSON.
	 *
	 * @subcommand export
	 */
	public function export_() {
		WP_CLI::line( wp_json_encode( SpeedPilot_Flags::all(), JSON_PRETTY_PRINT ) );
	}

	/**
	 * Imports a flags document from a JSON file.
	 *
	 * ## OPTIONS
	 *
	 * <file>
	 * : JSON file.
	 *
	 * [--reason=<reason>]
	 * : Change log line.
	 *
	 * @subcommand import
	 * @param array $args Args.
	 * @param array $assoc Assoc args.
	 */
	public function import_( $args, $assoc ) {
		$doc = json_decode( (string) file_get_contents( $args[0] ), true ); // phpcs:ignore WordPress.WP.AlternativeFunctions
		if ( ! is_array( $doc ) || ! isset( $doc['modules'] ) ) {
			WP_CLI::error( 'Not a SpeedPilot flags document.' );
		}
		SpeedPilot_Flags::save( $doc, isset( $assoc['reason'] ) ? $assoc['reason'] : 'import' );
		WP_CLI::success( 'Imported.' );
	}

	/**
	 * Turns one module on with optional rules and settings (JSON).
	 *
	 * ## OPTIONS
	 *
	 * <module>
	 * : Module key.
	 *
	 * [--rules=<json>]
	 * : Rules JSON.
	 *
	 * [--settings=<json>]
	 * : Settings JSON.
	 *
	 * [--reason=<reason>]
	 * : Change log line.
	 *
	 * @param array $args Args.
	 * @param array $assoc Assoc args.
	 */
	public function enable( $args, $assoc ) {
		$key = $args[0];
		if ( ! isset( SpeedPilot_Modules::registry()[ $key ] ) ) {
			WP_CLI::error( "Unknown module $key." );
		}
		$doc                   = SpeedPilot_Flags::all();
		$doc['modules'][ $key ] = array(
			'enabled'  => true,
			'rules'    => isset( $assoc['rules'] ) ? (array) json_decode( $assoc['rules'], true ) : array(),
			'settings' => isset( $assoc['settings'] ) ? (array) json_decode( $assoc['settings'], true ) : array(),
		);
		SpeedPilot_Flags::save( $doc, isset( $assoc['reason'] ) ? $assoc['reason'] : "enable $key" );
		WP_CLI::success( "Enabled $key." );
	}

	/**
	 * Turns one module off.
	 *
	 * ## OPTIONS
	 *
	 * <module>
	 * : Module key.
	 *
	 * [--reason=<reason>]
	 * : Change log line.
	 *
	 * @param array $args Args.
	 * @param array $assoc Assoc args.
	 */
	public function disable( $args, $assoc ) {
		$doc = SpeedPilot_Flags::all();
		if ( isset( $doc['modules'][ $args[0] ] ) ) {
			$doc['modules'][ $args[0] ]['enabled'] = false;
		}
		SpeedPilot_Flags::save( $doc, isset( $assoc['reason'] ) ? $assoc['reason'] : 'disable ' . $args[0] );
		WP_CLI::success( 'Disabled ' . $args[0] . '.' );
	}

	/**
	 * Turns every module off (emergency).
	 *
	 * @subcommand disable-all
	 */
	public function disable_all() {
		$doc = SpeedPilot_Flags::all();
		foreach ( $doc['modules'] as $k => $m ) {
			$doc['modules'][ $k ]['enabled'] = false;
		}
		SpeedPilot_Flags::save( $doc, 'disable all' );
		WP_CLI::success( 'All modules disabled.' );
	}

	/**
	 * Lists available modules and their state.
	 *
	 * @subcommand list
	 */
	public function list_() {
		$doc  = SpeedPilot_Flags::all();
		$rows = array();
		foreach ( SpeedPilot_Modules::registry() as $key => $file ) {
			$rows[] = array(
				'module'  => $key,
				'enabled' => ! empty( $doc['modules'][ $key ]['enabled'] ) ? 'yes' : 'no',
			);
		}
		WP_CLI\Utils\format_items( 'table', $rows, array( 'module', 'enabled' ) );
	}

	/**
	 * SAFE-05 usage scan (read-only): where a shortcode, block, CSS class or builder widget is used across all published
	 * content, widgets, menus, builder data and theme templates. Prints JSON.
	 *
	 * ## OPTIONS
	 *
	 * [--shortcodes=<list>]
	 * : Comma-separated shortcode tags.
	 *
	 * [--blocks=<list>]
	 * : Comma-separated block names.
	 *
	 * [--needles=<list>]
	 * : Comma-separated strings (CSS classes, widget names) to find in content, builder data and templates.
	 *
	 * @subcommand usage-scan
	 * @param array $args Args.
	 * @param array $assoc Assoc args.
	 */
	public function usage_scan( $args, $assoc ) {
		$split      = function ( $k ) use ( $assoc ) {
			return isset( $assoc[ $k ] ) && '' !== $assoc[ $k ] ? array_filter( array_map( 'trim', explode( ',', $assoc[ $k ] ) ) ) : array();
		};
		$shortcodes = $split( 'shortcodes' );
		$blocks     = $split( 'blocks' );
		$needles    = $split( 'needles' );
		$hits       = array(
			'posts'     => array(),
			'widgets'   => array(),
			'menus'     => array(),
			'builder'   => array(),
			'templates' => array(),
			'scanned'   => array(),
		);
		$match      = function ( $text ) use ( $shortcodes, $blocks, $needles ) {
			foreach ( $shortcodes as $sc ) {
				if ( has_shortcode( $text, $sc ) || false !== strpos( $text, '[' . $sc ) ) {
					return '[' . $sc . ']';
				}
			}
			foreach ( $blocks as $b ) {
				if ( false !== strpos( $text, '<!-- wp:' . $b ) ) {
					return 'block ' . $b;
				}
			}
			foreach ( $needles as $n ) {
				if ( false !== strpos( $text, $n ) ) {
					return $n;
				}
			}
			return '';
		};
		$types = get_post_types( array( 'public' => true ) );
		$page  = 1;
		do {
			$ids = get_posts(
				array(
					'post_type'      => array_values( $types ),
					'post_status'    => 'publish',
					'posts_per_page' => 200,
					'paged'          => $page,
					'fields'         => 'ids',
					'orderby'        => 'ID',
					'order'          => 'ASC',
				)
			);
			foreach ( $ids as $id ) {
				$m = $match( (string) get_post_field( 'post_content', $id ) );
				if ( '' !== $m ) {
					$hits['posts'][] = array(
						'id'   => $id,
						'url'  => get_permalink( $id ),
						'type' => get_post_type( $id ),
						'hit'  => $m,
					);
				}
				$data = (string) get_post_meta( $id, '_elementor_data', true );
				if ( '' !== $data ) {
					$m = $match( $data );
					if ( '' !== $m ) {
						$hits['builder'][] = array(
							'id'  => $id,
							'url' => get_permalink( $id ),
							'hit' => $m,
						);
					}
				}
			}
			$hits['scanned']['posts'] = ( isset( $hits['scanned']['posts'] ) ? $hits['scanned']['posts'] : 0 ) + count( $ids );
			++$page;
		} while ( count( $ids ) === 200 );
		global $wpdb;
		$widget_opts = $wpdb->get_col( "SELECT option_name FROM {$wpdb->options} WHERE option_name LIKE 'widget\\_%'" ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery
		foreach ( $widget_opts as $opt ) {
			$m = $match( (string) wp_json_encode( get_option( $opt ) ) );
			if ( '' !== $m ) {
				$hits['widgets'][] = array(
					'option' => $opt,
					'hit'    => $m,
				);
			}
		}
		foreach ( wp_get_nav_menus() as $menu ) {
			foreach ( (array) wp_get_nav_menu_items( $menu->term_id ) as $item ) {
				$m = $match( $item->title . ' ' . $item->url . ' ' . implode( ' ', (array) $item->classes ) );
				if ( '' !== $m ) {
					$hits['menus'][] = array(
						'menu' => $menu->name,
						'item' => $item->title,
						'hit'  => $m,
					);
				}
			}
		}
		foreach ( array_unique( array( get_stylesheet_directory(), get_template_directory() ) ) as $dir ) {
			$it = new RecursiveIteratorIterator( new RecursiveDirectoryIterator( $dir, FilesystemIterator::SKIP_DOTS ) );
			foreach ( $it as $f ) {
				if ( 'php' !== $f->getExtension() && 'html' !== $f->getExtension() ) {
					continue;
				}
				$m = $match( (string) file_get_contents( $f->getPathname() ) ); // phpcs:ignore WordPress.WP.AlternativeFunctions
				if ( '' !== $m ) {
					$hits['templates'][] = array(
						'file' => str_replace( $dir . '/', '', $f->getPathname() ),
						'hit'  => $m,
					);
				}
			}
		}
		WP_CLI::line( wp_json_encode( $hits ) );
	}

	/**
	 * Writes a file under uploads/speedpilot/ only (fonts, resized images, patched scripts). Content comes from STDIN
	 * as base64. The agent itself never downloads anything.
	 *
	 * ## OPTIONS
	 *
	 * <path>
	 * : Path relative to uploads/speedpilot/.
	 *
	 * @subcommand put-file
	 * @param array $args Args.
	 */
	public function put_file( $args ) {
		$rel = ltrim( str_replace( '\\', '/', $args[0] ), '/' );
		if ( '' === $rel || false !== strpos( $rel, '..' ) || ! preg_match( '#^(fonts|img|js|css)/[A-Za-z0-9._/-]+$#', $rel ) ) {
			WP_CLI::error( 'Path must be fonts/, img/, js/ or css/ under uploads/speedpilot/, without "..".' );
		}
		$up   = wp_upload_dir();
		$dest = trailingslashit( $up['basedir'] ) . 'speedpilot/' . $rel;
		wp_mkdir_p( dirname( $dest ) );
		$data = base64_decode( (string) file_get_contents( 'php://stdin' ), true ); // phpcs:ignore WordPress.WP.AlternativeFunctions,WordPress.PHP.DiscouragedPHPFunctions
		if ( false === $data ) {
			WP_CLI::error( 'STDIN is not base64.' );
		}
		file_put_contents( $dest, $data ); // phpcs:ignore WordPress.WP.AlternativeFunctions
		WP_CLI::line( wp_json_encode( array( 'url' => trailingslashit( $up['baseurl'] ) . 'speedpilot/' . $rel, 'bytes' => strlen( $data ) ) ) );
	}

	/**
	 * Builds resized WebP copies of images into uploads/speedpilot/img/ (originals untouched) and prints the srcset
	 * map for the images module.
	 *
	 * ## OPTIONS
	 *
	 * <urls>
	 * : Comma-separated image URLs on this site.
	 *
	 * [--widths=<list>]
	 * : Comma-separated widths.
	 * ---
	 * default: 400,800,1200
	 * ---
	 *
	 * @subcommand images-build
	 * @param array $args Args.
	 * @param array $assoc Assoc args.
	 */
	public function images_build( $args, $assoc ) {
		$up     = wp_upload_dir();
		$out    = array();
		$widths = array_map( 'intval', explode( ',', isset( $assoc['widths'] ) ? $assoc['widths'] : '400,800,1200' ) );
		foreach ( explode( ',', $args[0] ) as $url ) {
			$url  = trim( $url );
			$path = '';
			foreach ( array( content_url() => WP_CONTENT_DIR, site_url() => ABSPATH ) as $base => $dir ) {
				if ( 0 === strpos( $url, $base ) ) {
					$path = rtrim( $dir, '/' ) . '/' . ltrim( substr( $url, strlen( $base ) ), '/' );
					break;
				}
			}
			$path = strtok( $path, '?' );
			if ( '' === $path || ! file_exists( $path ) || false !== strpos( $path, '..' ) ) {
				WP_CLI::warning( "Skipping $url (not a local file)." );
				continue;
			}
			$size = wp_getimagesize( $path );
			$set  = array();
			foreach ( $widths as $w ) {
				if ( ! $size || $w >= $size[0] ) {
					continue;
				}
				$editor = wp_get_image_editor( $path );
				if ( is_wp_error( $editor ) ) {
					WP_CLI::warning( $editor->get_error_message() );
					continue;
				}
				$editor->resize( $w, null );
				$name = substr( md5( $url ), 0, 8 ) . '-' . pathinfo( $path, PATHINFO_FILENAME ) . '-' . $w . 'w';
				$mime = wp_image_editor_supports( array( 'mime_type' => 'image/webp' ) ) ? 'image/webp' : $size['mime'];
				$ext  = 'image/webp' === $mime ? 'webp' : pathinfo( $path, PATHINFO_EXTENSION );
				$dest = trailingslashit( $up['basedir'] ) . "speedpilot/img/$name.$ext";
				wp_mkdir_p( dirname( $dest ) );
				$saved = $editor->save( $dest, $mime );
				if ( is_wp_error( $saved ) ) {
					WP_CLI::warning( $saved->get_error_message() );
					continue;
				}
				$set[] = trailingslashit( $up['baseurl'] ) . "speedpilot/img/$name.$ext {$w}w";
			}
			if ( $size ) {
				$set[] = $url . ' ' . $size[0] . 'w';
			}
			$out[ $url ] = array(
				'srcset' => implode( ', ', $set ),
				'width'  => $size ? $size[0] : null,
				'height' => $size ? $size[1] : null,
			);
		}
		WP_CLI::line( wp_json_encode( $out ) );
	}

	/**
	 * Scripted database step (WPB-04): turns autoload off (or back on, the undo step) for named options.
	 *
	 * ## OPTIONS
	 *
	 * <state>
	 * : off or on.
	 *
	 * <options>...
	 * : Option names.
	 *
	 * @param array $args Args.
	 */
	public function autoload( $args ) {
		$state = array_shift( $args );
		if ( ! in_array( $state, array( 'on', 'off' ), true ) ) {
			WP_CLI::error( 'State must be on or off.' );
		}
		$done = array();
		foreach ( $args as $name ) {
			if ( function_exists( 'wp_set_option_autoload' ) ) {
				wp_set_option_autoload( $name, 'on' === $state );
			} else {
				global $wpdb;
				$wpdb->update( $wpdb->options, array( 'autoload' => 'on' === $state ? 'yes' : 'no' ), array( 'option_name' => $name ) ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery
				wp_cache_delete( 'alloptions', 'options' );
			}
			$done[] = $name;
		}
		WP_CLI::success( 'Autoload ' . $state . ': ' . implode( ', ', $done ) . '. Undo: wp speedpilot autoload ' . ( 'on' === $state ? 'off' : 'on' ) . ' ' . implode( ' ', $done ) );
	}
}
