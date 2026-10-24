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
}
