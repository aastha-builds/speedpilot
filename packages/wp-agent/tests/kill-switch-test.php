<?php
/**
 * Run with: wp --exec="define('SPEEDPILOT_DISABLE', true);" eval-file kill-switch-test.php
 *
 * @package speedpilot-agent
 */

defined( 'ABSPATH' ) || exit;
echo class_exists( 'SpeedPilot_Flags' ) || class_exists( 'SpeedPilot_Diagnostics' ) ? "not ok 1 agent loaded despite SPEEDPILOT_DISABLE\n" : "ok 1 agent does nothing when SPEEDPILOT_DISABLE is true\n";
// with every module flag on in the database, no module code may load either
$speedpilot_module_symbols = array( 'speedpilot_lcp_settings', 'speedpilot_critical_css', 'speedpilot_cf7_needed', 'speedpilot_query_rule' );
$speedpilot_loaded         = array_filter( $speedpilot_module_symbols, 'function_exists' );
echo $speedpilot_loaded || class_exists( 'SpeedPilot_Html' ) ? 'not ok 2 module code loaded: ' . implode( ', ', $speedpilot_loaded ) . "\n" : "ok 2 no module code loads when SPEEDPILOT_DISABLE is true\n";
