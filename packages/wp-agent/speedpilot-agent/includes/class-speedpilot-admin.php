<?php
/**
 * Tools > SpeedPilot: active flags, last run, change log, kill switch. Nothing else.
 *
 * @package speedpilot-agent
 */

defined( 'ABSPATH' ) || exit;

/**
 * Admin page.
 */
class SpeedPilot_Admin {

	/**
	 * Registers the page.
	 */
	public static function boot() {
		add_action(
			'admin_menu',
			function () {
				add_management_page( 'SpeedPilot', 'SpeedPilot', 'manage_options', 'speedpilot', array( __CLASS__, 'render' ) );
			}
		);
	}

	/**
	 * Renders the page (read-only).
	 */
	public static function render() {
		if ( ! current_user_can( 'manage_options' ) ) {
			return;
		}
		$doc     = SpeedPilot_Flags::all();
		$enabled = array();
		foreach ( (array) $doc['modules'] as $key => $m ) {
			if ( ! empty( $m['enabled'] ) ) {
				$enabled[ $key ] = $m;
			}
		}
		$log  = isset( $doc['log'] ) ? array_reverse( (array) $doc['log'] ) : array();
		$last = $log ? $log[0] : null;
		echo '<div class="wrap"><h1>SpeedPilot</h1>';
		echo '<p>Agent ' . esc_html( SPEEDPILOT_AGENT_VERSION ) . ', flags version ' . (int) $doc['version'] . ( $last ? ', last change ' . esc_html( $last['time'] ) : '' ) . '.</p>';
		echo '<h2>Active flags</h2>';
		if ( ! $enabled ) {
			echo '<p>None. The agent does nothing.</p>';
		} else {
			echo '<table class="widefat striped"><thead><tr><th>Module</th><th>Rules</th></tr></thead><tbody>';
			foreach ( $enabled as $key => $m ) {
				echo '<tr><td><code>' . esc_html( $key ) . '</code></td><td><code>' . esc_html( wp_json_encode( isset( $m['rules'] ) ? $m['rules'] : array() ) ) . '</code></td></tr>';
			}
			echo '</tbody></table>';
		}
		echo '<h2>Change log</h2><ul>';
		foreach ( array_slice( $log, 0, 20 ) as $l ) {
			echo '<li>v' . (int) $l['version'] . ' ' . esc_html( $l['time'] ) . ' &mdash; ' . esc_html( $l['reason'] ) . '</li>';
		}
		echo '</ul><h2>Kill switch</h2>';
		echo '<p>To turn every SpeedPilot optimization off at once, add <code>define( \'SPEEDPILOT_DISABLE\', true );</code> to wp-config.php, or rename <code>wp-content/mu-plugins/speedpilot-agent.php</code> over SFTP if wp-admin is down. Admins can compare any page with <code>?speedpilot=off</code>.</p></div>';
	}
}
