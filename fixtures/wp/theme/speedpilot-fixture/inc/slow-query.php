<?php
/**
 * PLANTED WPB-12, WPB-13: an expensive theme query (posts_per_page => -1, orderby => rand, meta_query) run on every front-page view.
 *
 * @package speedpilot-fixture
 */

defined( 'ABSPATH' ) || exit;

/** Returns "related" posts the slow way. Caller: spf_related_posts(). */
function spf_related_posts() {
	$q = new WP_Query(
		array(
			'post_type'      => 'any',
			'posts_per_page' => -1,
			'orderby'        => 'rand',
			'meta_query'     => array(
				array(
					'key'     => '_spf_featured',
					'compare' => 'NOT EXISTS',
				),
			),
		)
	);
	$out = array();
	foreach ( $q->posts as $p ) {
		// a query inside a loop
		$out[] = get_post_meta( $p->ID, '_spf_rating', true );
	}
	// plus a deliberately slow query so it crosses the 50 ms threshold on any machine
	global $wpdb;
	$wpdb->get_var( "SELECT SLEEP(0.08) FROM {$wpdb->posts} LIMIT 1" ); // phpcs:ignore WordPress.DB.DirectDatabaseQuery
	return count( $out );
}
