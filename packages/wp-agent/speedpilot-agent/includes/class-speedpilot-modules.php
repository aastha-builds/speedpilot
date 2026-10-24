<?php
/**
 * Optimization module registry. Every module is one flag and loads its file only when its flag is on, so a request
 * with all flags off costs a single autoloaded-option read.
 *
 * @package speedpilot-agent
 */

defined( 'ABSPATH' ) || exit;

/**
 * Module registry.
 */
class SpeedPilot_Modules {

	/**
	 * Module key => file in modules/.
	 *
	 * @return array
	 */
	public static function registry() {
		$files = array();
		foreach ( (array) glob( SPEEDPILOT_AGENT_DIR . '/modules/*.php' ) as $file ) {
			$files[ basename( $file, '.php' ) ] = $file;
		}
		return $files;
	}

	/**
	 * Loads enabled modules.
	 */
	public static function boot() {
		$doc = SpeedPilot_Flags::all();
		if ( empty( $doc['modules'] ) ) {
			return;
		}
		$registry = self::registry();
		foreach ( $doc['modules'] as $key => $module ) {
			if ( empty( $module['enabled'] ) || ! isset( $registry[ $key ] ) ) {
				continue;
			}
			require_once $registry[ $key ];
		}
	}
}
