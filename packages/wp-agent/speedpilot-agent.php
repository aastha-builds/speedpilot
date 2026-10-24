<?php
/**
 * Plugin Name: SpeedPilot Agent
 * Description: Feature-flag speed optimizations, authenticated diagnostics and Server-Timing for SpeedPilot. Does nothing unless a flag is on. Kill switch: define( 'SPEEDPILOT_DISABLE', true ); in wp-config.php, or rename this file.
 * Version: 0.1.0
 * Requires PHP: 7.4
 * License: Proprietary
 *
 * @package speedpilot-agent
 */

defined( 'ABSPATH' ) || exit;

if ( file_exists( __DIR__ . '/speedpilot-agent/bootstrap.php' ) ) {
	require_once __DIR__ . '/speedpilot-agent/bootstrap.php';
}
