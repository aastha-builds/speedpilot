<?php
/**
 * Run with: wp --exec="define('SPEEDPILOT_DISABLE', true);" eval-file kill-switch-test.php
 *
 * @package speedpilot-agent
 */

defined( 'ABSPATH' ) || exit;
echo class_exists( 'SpeedPilot_Flags' ) || class_exists( 'SpeedPilot_Diagnostics' ) ? "not ok 1 agent loaded despite SPEEDPILOT_DISABLE\n" : "ok 1 agent does nothing when SPEEDPILOT_DISABLE is true\n";
