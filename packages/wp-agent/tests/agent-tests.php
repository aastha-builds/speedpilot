<?php
/**
 * SpeedPilot agent tests. Run inside a WordPress install with the agent as an mu-plugin:
 *   wp eval-file packages/wp-agent/tests/agent-tests.php
 * (pnpm test:php runs them on PHP 7.4, 8.3 and 8.4 against the local fixture.)
 * A tiny harness so the suite needs no Composer or PHPUnit download; prints TAP.
 *
 * @package speedpilot-agent
 */

defined( 'ABSPATH' ) || exit;

$GLOBALS['spt_results'] = array();

/**
 * Assertion.
 *
 * @param bool   $cond Condition.
 * @param string $name Test name.
 */
function spt_ok( $cond, $name ) {
	global $spt_results;
	$spt_results[] = array( (bool) $cond, $name );
}

if ( ! class_exists( 'SpeedPilot_Flags' ) ) {
	echo "1..1\nnot ok 1 agent not loaded\n";
	return;
}

$spt_backup = get_option( SPEEDPILOT_FLAGS_OPTION, null );

// Flags default to nothing enabled.
delete_option( SPEEDPILOT_FLAGS_OPTION );
SpeedPilot_Flags::reset_cache();
$doc = SpeedPilot_Flags::all();
spt_ok( array() === $doc['modules'], 'flags default to no modules' );
spt_ok( false === SpeedPilot_Flags::enabled( 'core_extras' ), 'a missing module is off' );

// Save, version and log.
$saved = SpeedPilot_Flags::save( array( 'modules' => array( 'core_extras' => array( 'enabled' => true, 'rules' => array() ) ) ), 'test enable' );
spt_ok( 1 === $saved['version'], 'save bumps the version' );
spt_ok( 'test enable' === end( $saved['log'] )['reason'], 'save logs the reason' );
SpeedPilot_Flags::reset_cache();
spt_ok( true === SpeedPilot_Flags::enabled( 'core_extras' ), 'saved module is on' );
$autoload = $GLOBALS['wpdb']->get_var( $GLOBALS['wpdb']->prepare( "SELECT autoload FROM {$GLOBALS['wpdb']->options} WHERE option_name = %s", SPEEDPILOT_FLAGS_OPTION ) );
spt_ok( in_array( $autoload, array( 'yes', 'on', 'auto-on' ), true ), 'flags option is autoloaded (zero extra queries)' );

// Rules.
$_SERVER['REQUEST_URI'] = '/contact/';
spt_ok( SpeedPilot_Flags::rules_match( array( 'urls' => array( '/contact/' ) ) ), 'url rule matches exact path' );
spt_ok( ! SpeedPilot_Flags::rules_match( array( 'urls' => array( '/shop/' ) ) ), 'url rule rejects other paths' );
spt_ok( SpeedPilot_Flags::rules_match( array( 'urls' => array( '/con*' ) ) ), 'url rule with prefix wildcard' );
spt_ok( ! SpeedPilot_Flags::rules_match( array( 'exclude' => array( '/contact' ) ) ), 'exclude wins' );
$_SERVER['REQUEST_URI'] = '/';

// HMAC tokens.
$secret = SpeedPilot_Auth::secret();
spt_ok( strlen( $secret ) >= 16, 'fixture defines SPEEDPILOT_HMAC_SECRET' );
$exp = time() + 60;
$_SERVER['HTTP_X_SPEEDPILOT_TOKEN'] = $exp . '.diag.' . hash_hmac( 'sha256', $exp . '.diag', $secret );
spt_ok( SpeedPilot_Auth::token_valid( 'diag' ), 'valid token accepted' );
spt_ok( ! SpeedPilot_Auth::token_valid( 'timing' ), 'token scope enforced' );
$_SERVER['HTTP_X_SPEEDPILOT_TOKEN'] = $exp . '.diag.' . hash_hmac( 'sha256', $exp . '.diag', 'wrong-secret-wrong-secret' );
spt_ok( ! SpeedPilot_Auth::token_valid( 'diag' ), 'forged token refused' );
$old = time() - 1;
$_SERVER['HTTP_X_SPEEDPILOT_TOKEN'] = $old . '.diag.' . hash_hmac( 'sha256', $old . '.diag', $secret );
spt_ok( ! SpeedPilot_Auth::token_valid( 'diag' ), 'expired token refused' );
$far = time() + 3600;
$_SERVER['HTTP_X_SPEEDPILOT_TOKEN'] = $far . '.diag.' . hash_hmac( 'sha256', $far . '.diag', $secret );
spt_ok( ! SpeedPilot_Auth::token_valid( 'diag' ), 'token valid for more than 5 minutes refused' );
unset( $_SERVER['HTTP_X_SPEEDPILOT_TOKEN'] );

// Unauthenticated REST diagnostics are refused.
wp_set_current_user( 0 );
$perm = SpeedPilot_Auth::rest_permission();
spt_ok( is_wp_error( $perm ) && 401 === $perm->get_error_data()['status'], 'unauthenticated diagnostics refused with 401' );
$admins = get_users( array( 'role' => 'administrator', 'number' => 1 ) );
if ( $admins ) {
	wp_set_current_user( $admins[0]->ID );
	spt_ok( true === SpeedPilot_Auth::rest_permission(), 'admin with manage_options allowed' );
	wp_set_current_user( 0 );
}
$subscriber = wp_insert_user( array( 'user_login' => 'spt_sub_' . wp_generate_password( 4, false ), 'user_pass' => wp_generate_password(), 'role' => 'subscriber' ) );
if ( ! is_wp_error( $subscriber ) ) {
	wp_set_current_user( $subscriber );
	$p = SpeedPilot_Auth::rest_permission();
	spt_ok( is_wp_error( $p ) && 403 === $p->get_error_data()['status'], 'logged-in user without manage_options refused with 403' );
	wp_set_current_user( 0 );
	require_once ABSPATH . 'wp-admin/includes/user.php';
	wp_delete_user( $subscriber );
}

// Owners.
spt_ok( 'plugin:contact-form-7' === SpeedPilot_Diagnostics::owner_of_src( home_url( '/wp-content/plugins/contact-form-7/x.js' ) ), 'src owner plugin' );
spt_ok( 'core:wordpress' === SpeedPilot_Diagnostics::owner_of_src( home_url( '/wp-includes/js/jquery/jquery.min.js' ) ), 'src owner core' );
spt_ok( 'plugin:woocommerce' === SpeedPilot_Diagnostics::option_owner( 'woocommerce_db_version' ), 'option owner by prefix' );
spt_ok( 0 === strpos( SpeedPilot_Diagnostics::option_owner( 'oldstats_plugin_data' ), 'unknown:' ), 'option of a removed plugin is unknown' );

// ?speedpilot=off never works for the public.
$_GET['speedpilot'] = 'off';
spt_ok( false === SpeedPilot_Flags::bypassed(), '?speedpilot=off ignored for anonymous visitors' );
unset( $_GET['speedpilot'] );

// Diagnostics do not run without a token.
spt_ok( false === has_action( 'wp_footer', array( 'SpeedPilot_Diagnostics', 'footer_report' ) ), 'no diagnostics hooks for normal requests' );

// Restore.
if ( null === $spt_backup ) {
	delete_option( SPEEDPILOT_FLAGS_OPTION );
} else {
	update_option( SPEEDPILOT_FLAGS_OPTION, $spt_backup, true );
}
SpeedPilot_Flags::reset_cache();

echo '1..' . count( $GLOBALS['spt_results'] ) . "\n";
$failed = 0;
foreach ( $GLOBALS['spt_results'] as $i => $r ) {
	echo ( $r[0] ? 'ok ' : 'not ok ' ) . ( $i + 1 ) . ' ' . $r[1] . "\n";
	if ( ! $r[0] ) {
		$failed++;
	}
}
echo '# PHP ' . PHP_VERSION . ', WordPress ' . get_bloginfo( 'version' ) . ', ' . $failed . " failed\n";
