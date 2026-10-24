<?php
/**
 * Module query-cache (SPEC.md 8.1 backend, WPB-12, WPB-13): bounds and caches expensive front-end WP_Query calls that
 * the X-ray traced to a theme or plugin function, without editing that code. Matching queries get a posts_per_page cap,
 * orderby rand replaced, the post meta cache primed (no query in a loop), and their post IDs kept in a transient so
 * repeat views skip the query. Writes nothing but its own transients.
 *
 * Settings: rules[] {match: {query var: value}, cap, orderby, ttl}.
 *
 * @package speedpilot-agent
 */

defined( 'ABSPATH' ) || exit;

/**
 * The query-cache rule matching a query, or null.
 *
 * @param WP_Query $q Query.
 * @return array|null
 */
function speedpilot_query_rule( $q ) {
	if ( is_admin() || ! SpeedPilot_Flags::enabled( 'query-cache' ) || $q->is_main_query() ) {
		return null;
	}
	$s = SpeedPilot_Flags::settings( 'query-cache' );
	foreach ( isset( $s['rules'] ) ? (array) $s['rules'] : array() as $i => $rule ) {
		$ok = ! empty( $rule['match'] );
		foreach ( isset( $rule['match'] ) ? (array) $rule['match'] : array() as $k => $v ) {
			if ( $q->get( $k ) != $v ) { // phpcs:ignore Universal.Operators.StrictComparisons -- query vars are loosely typed
				$ok = false;
			}
		}
		if ( $ok ) {
			$rule['id'] = $i;
			return $rule;
		}
	}
	return null;
}

add_action(
	'pre_get_posts',
	function ( $q ) {
		$rule = speedpilot_query_rule( $q );
		if ( ! $rule ) {
			return;
		}
		$q->set( 'speedpilot_rule', $rule['id'] );
		if ( ! empty( $rule['cap'] ) && ( (int) $q->get( 'posts_per_page' ) < 0 || (int) $q->get( 'posts_per_page' ) > (int) $rule['cap'] ) ) {
			$q->set( 'posts_per_page', (int) $rule['cap'] );
		}
		if ( 'rand' === $q->get( 'orderby' ) ) {
			$q->set( 'orderby', ! empty( $rule['orderby'] ) ? $rule['orderby'] : 'date' );
		}
		$q->set( 'no_found_rows', true );
		$q->set( 'update_post_meta_cache', true );
	},
	99
);

add_filter(
	'posts_pre_query',
	function ( $posts, $q ) {
		if ( null !== $posts || '' === $q->get( 'speedpilot_rule' ) || null === $q->get( 'speedpilot_rule', null ) ) {
			return $posts;
		}
		$key = 'speedpilot_qc_' . md5( wp_json_encode( $q->query_vars ) );
		$ids = get_transient( $key );
		if ( ! is_array( $ids ) ) {
			return $posts;
		}
		$q->speedpilot_cached = true;
		if ( empty( $ids ) ) {
			return array();
		}
		_prime_post_caches( $ids, true, true );
		return array_map( 'get_post', $ids );
	},
	10,
	2
);

add_filter(
	'the_posts',
	function ( $posts, $q ) {
		if ( '' === $q->get( 'speedpilot_rule' ) || null === $q->get( 'speedpilot_rule', null ) || ! empty( $q->speedpilot_cached ) ) {
			return $posts;
		}
		$s    = SpeedPilot_Flags::settings( 'query-cache' );
		$rule = isset( $s['rules'][ (int) $q->get( 'speedpilot_rule' ) ] ) ? $s['rules'][ (int) $q->get( 'speedpilot_rule' ) ] : array();
		$ttl  = ! empty( $rule['ttl'] ) ? (int) $rule['ttl'] : 600;
		set_transient( 'speedpilot_qc_' . md5( wp_json_encode( $q->query_vars ) ), wp_list_pluck( $posts, 'ID' ), $ttl );
		return $posts;
	},
	10,
	2
);
