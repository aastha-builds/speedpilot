<?php
/**
 * SpeedPilot agent bootstrap. Loads early and does nothing unless a flag is on or a request is token-authenticated.
 *
 * @package speedpilot-agent
 */

defined( 'ABSPATH' ) || exit;

define( 'SPEEDPILOT_AGENT_VERSION', '0.1.0' );
define( 'SPEEDPILOT_AGENT_DIR', __DIR__ );
define( 'SPEEDPILOT_FLAGS_OPTION', 'speedpilot_flags' );

/**
 * Kill switch: SPEEDPILOT_DISABLE in wp-config.php turns everything off, including diagnostics.
 *
 * @return bool
 */
function speedpilot_agent_disabled() {
	return defined( 'SPEEDPILOT_DISABLE' ) && SPEEDPILOT_DISABLE;
}

if ( speedpilot_agent_disabled() ) {
	return;
}

$GLOBALS['speedpilot_t0'] = isset( $_SERVER['REQUEST_TIME_FLOAT'] ) ? (float) $_SERVER['REQUEST_TIME_FLOAT'] : microtime( true );
$GLOBALS['speedpilot_marks'] = array( 'mu_plugins' => microtime( true ) );

require_once __DIR__ . '/includes/class-speedpilot-flags.php';
require_once __DIR__ . '/includes/class-speedpilot-modules.php';

/**
 * Loads authentication and diagnostics only when something needs them (REST, Abilities, token requests, admin),
 * so a normal visitor's request reads one autoloaded option and nothing else.
 */
function speedpilot_agent_load_diagnostics() {
	require_once __DIR__ . '/includes/class-speedpilot-auth.php';
	require_once __DIR__ . '/includes/class-speedpilot-diagnostics.php';
}

add_action(
	'rest_api_init',
	function () {
		speedpilot_agent_load_diagnostics();
		SpeedPilot_Diagnostics::routes();
	}
);
add_action(
	'wp_abilities_api_categories_init',
	function () {
		speedpilot_agent_load_diagnostics();
		SpeedPilot_Diagnostics::ability_category();
	}
);
add_action(
	'wp_abilities_api_init',
	function () {
		speedpilot_agent_load_diagnostics();
		SpeedPilot_Diagnostics::abilities();
	}
);
SpeedPilot_Modules::boot();
// The visitor-facing cost ends here (reported as sp-agent-booted in Server-Timing for token requests).
$GLOBALS['speedpilot_marks']['agent_booted'] = microtime( true );
if ( ! empty( $_SERVER['HTTP_X_SPEEDPILOT_TOKEN'] ) ) {
	speedpilot_agent_load_diagnostics();
	SpeedPilot_Diagnostics::boot();
}
if ( is_admin() ) {
	speedpilot_agent_load_diagnostics();
	require_once __DIR__ . '/includes/class-speedpilot-admin.php';
	SpeedPilot_Admin::boot();
}

if ( defined( 'WP_CLI' ) && WP_CLI ) {
	speedpilot_agent_load_diagnostics();
	require_once __DIR__ . '/includes/class-speedpilot-cli.php';
	WP_CLI::add_command( 'speedpilot', 'SpeedPilot_CLI' );
}
