<?php
/**
 * Module images (SPEC.md 8.1, IMG-03, IMG-06, IMG-07, IMG-08): missing width and height (from attachment metadata, or
 * from dimensions SpeedPilot measured), lazy loading below the fold for images and iframes, responsive srcset for
 * resized copies built by `wp speedpilot images build`, and sizes="auto" for lazy images where core supports it.
 *
 * Settings: dimensions {src fragment: [w, h]}, eagerCount (first N images stay eager), lazyIframes (bool),
 * srcset {src fragment: {srcset, sizes}}, skip (src fragments never touched, for example the LCP image).
 *
 * @package speedpilot-agent
 */

defined( 'ABSPATH' ) || exit;

require_once SPEEDPILOT_AGENT_DIR . '/includes/class-speedpilot-html.php';

// Attachments: core adds dimensions from metadata; make sure it stays on.
add_filter( 'wp_img_tag_add_width_and_height_attr', '__return_true', 99 );

SpeedPilot_Html::add(
	function ( $html ) {
		if ( ! SpeedPilot_Flags::enabled( 'images' ) ) {
			return $html;
		}
		$s     = SpeedPilot_Flags::settings( 'images' );
		$dims  = isset( $s['dimensions'] ) ? (array) $s['dimensions'] : array();
		$sets  = isset( $s['srcset'] ) ? (array) $s['srcset'] : array();
		$skip  = isset( $s['skip'] ) ? (array) $s['skip'] : array();
		$eager = isset( $s['eagerCount'] ) ? (int) $s['eagerCount'] : 1;
		$find  = function ( $map, $src ) {
			foreach ( $map as $frag => $v ) {
				if ( '' !== $frag && false !== strpos( $src, (string) $frag ) ) {
					return $v;
				}
			}
			return null;
		};
		$p = new WP_HTML_Tag_Processor( $html );
		$n = 0;
		while ( $p->next_tag() ) {
			$tag = $p->get_tag();
			if ( 'IFRAME' === $tag && ! empty( $s['lazyIframes'] ) && null === $p->get_attribute( 'loading' ) ) {
				$p->set_attribute( 'loading', 'lazy' );
				continue;
			}
			if ( 'IMG' !== $tag ) {
				continue;
			}
			$src = (string) $p->get_attribute( 'src' );
			++$n;
			$skipped = false;
			foreach ( $skip as $frag ) {
				if ( '' !== $frag && false !== strpos( $src, $frag ) ) {
					$skipped = true;
				}
			}
			$d = $find( $dims, $src );
			if ( is_array( $d ) && 2 === count( $d ) && null === $p->get_attribute( 'width' ) && null === $p->get_attribute( 'height' ) ) {
				$p->set_attribute( 'width', (string) (int) $d[0] );
				$p->set_attribute( 'height', (string) (int) $d[1] );
			}
			if ( $skipped ) {
				continue;
			}
			$set = $find( $sets, $src );
			if ( is_array( $set ) && ! empty( $set['srcset'] ) && null === $p->get_attribute( 'srcset' ) ) {
				$p->set_attribute( 'srcset', $set['srcset'] );
				$p->set_attribute( 'sizes', ! empty( $set['sizes'] ) ? $set['sizes'] : '100vw' );
			}
			if ( $n > $eager && null === $p->get_attribute( 'loading' ) && null === $p->get_attribute( 'fetchpriority' ) ) {
				$p->set_attribute( 'loading', 'lazy' );
				$p->set_attribute( 'decoding', 'async' );
				$sizes = $p->get_attribute( 'sizes' );
				if ( is_string( $sizes ) && 0 !== strpos( $sizes, 'auto' ) && version_compare( get_bloginfo( 'version' ), '6.7', '>=' ) ) {
					$p->set_attribute( 'sizes', 'auto, ' . $sizes );
				}
			}
		}
		return $p->get_updated_html();
	},
	6
);
