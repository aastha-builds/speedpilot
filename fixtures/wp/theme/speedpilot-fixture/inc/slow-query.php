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
			'spf_related'    => 1,
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
	return count( $out );
}

/**
 * Makes the related-posts query itself slow (about 80 ms) on any machine, standing in for a large postmeta table: a
 * derived table that MySQL evaluates once per query. The query stays the theme's, with spf_related_posts as caller.
 */
add_filter(
	'posts_join',
	function ( $join, $q ) {
		return $q->get( 'spf_related' ) ? $join . ' JOIN (SELECT SLEEP(0.08) AS spf_s) AS spf_slow' : $join;
	},
	10,
	2
);
