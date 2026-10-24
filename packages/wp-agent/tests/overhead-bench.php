<?php
/**
 * Overhead benchmark (SPEC.md 8.1): the agent must add under 2 ms and zero database queries per request, with all
 * flags off and with all flags on. Run with `wp eval-file overhead-bench.php <html-file>` after the flags are set; it
 * prints JSON. Agent time = its bootstrap + its hook callbacks + its HTML pass; callbacks are timed as the difference
 * between the module flags on and the same request with the in-memory flags cleared.
 *
 * @package speedpilot-agent
 */

// phpcs:disable WordPress.Security.EscapeOutput, WordPress.WP.AlternativeFunctions
$html_file = isset( $args[0] ) ? $args[0] : '';
$html      = $html_file && file_exists( $html_file ) ? file_get_contents( $html_file ) : '<html><head></head><body><img src="/a.jpg"></body></html>';

global $wpdb;
$marks = $GLOBALS['speedpilot_marks'];
$boot  = isset( $marks['agent_booted'] ) ? ( $marks['agent_booted'] - $marks['mu_plugins'] ) * 1000 : 0;

// a front-end request for the home page
$_SERVER['REQUEST_URI']    = '/';
$_SERVER['REQUEST_METHOD'] = 'GET';
wp();

$set_flags = function ( $doc ) {
	$r = new ReflectionProperty( 'SpeedPilot_Flags', 'cache' );
	$r->setAccessible( true );
	$r->setValue( null, $doc );
};
$real = SpeedPilot_Flags::all();

$run = function () use ( $html ) {
	do_action( 'wp_enqueue_scripts' );
	apply_filters( 'wp_preload_resources', array() );
	apply_filters( 'wp_resource_hints', array(), 'preconnect' );
	apply_filters( 'wp_speculation_rules_configuration', array( 'mode' => 'prefetch', 'eagerness' => 'conservative' ) );
	foreach ( wp_scripts()->queue as $h ) {
		apply_filters( 'script_loader_tag', '<script src="/x.js" id="' . $h . '-js"></script>', $h, '/x.js' );
	}
	foreach ( wp_styles()->queue as $h ) {
		apply_filters( 'style_loader_tag', "<link rel='stylesheet' id='$h-css' href='/x.css' media='all' />", $h, '/x.css', 'all' );
	}
	ob_start();
	do_action( 'wp_head' );
	do_action( 'wp_footer' );
	ob_end_clean();
	return class_exists( 'SpeedPilot_Html' ) ? SpeedPilot_Html::apply( $html ) : $html;
};

$measure = function ( $doc ) use ( $set_flags, $run, $wpdb ) {
	$times   = array();
	$queries = array();
	for ( $i = 0; $i < 15; $i++ ) {
		$set_flags( $doc );
		$q0 = $wpdb->num_queries;
		$t0 = microtime( true );
		$run();
		$times[]   = ( microtime( true ) - $t0 ) * 1000;
		$queries[] = $wpdb->num_queries - $q0;
	}
	sort( $times );
	return array( 'ms' => $times[ (int) floor( count( $times ) / 2 ) ], 'queries' => max( $queries ) );
};

$off_doc = array( 'version' => 0, 'modules' => array(), 'log' => array() );
// warm up caches (theme, plugins and the agent alike)
$measure( $real );
$measure( $off_doc );
$on  = $measure( $real );
$off = $measure( $off_doc );

$enabled = array_keys( array_filter( (array) $real['modules'], function ( $m ) {
	return ! empty( $m['enabled'] );
} ) );
echo wp_json_encode(
	array(
		'enabled'      => $enabled,
		'bootMs'       => round( $boot, 3 ),
		'callbacksMs'  => round( max( 0, $on['ms'] - $off['ms'] ), 3 ),
		'agentMs'      => round( $boot + max( 0, $on['ms'] - $off['ms'] ), 3 ),
		'queriesAdded' => max( 0, $on['queries'] - $off['queries'] ),
		'onMs'         => round( $on['ms'], 3 ),
		'offMs'        => round( $off['ms'], 3 ),
	)
);
