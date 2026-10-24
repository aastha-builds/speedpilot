<?php
/**
 * Module resource-hints (SPEC.md 8.1, NET-04, NET-05): preconnect only to 2 or 3 critical origins, dns-prefetch for
 * the rest, remove unused preconnects and prefetches.
 *
 * Settings: preconnect[] (max 3 origins), dnsPrefetch[], remove[] (URLs or hosts).
 *
 * @package speedpilot-agent
 */

defined( 'ABSPATH' ) || exit;

add_filter(
	'wp_resource_hints',
	function ( $urls, $relation ) {
		if ( ! SpeedPilot_Flags::enabled( 'resource-hints' ) ) {
			return $urls;
		}
		$s      = SpeedPilot_Flags::settings( 'resource-hints' );
		$remove = isset( $s['remove'] ) ? (array) $s['remove'] : array();
		$urls   = array_values(
			array_filter(
				(array) $urls,
				function ( $u ) use ( $remove ) {
					$href = is_array( $u ) ? ( isset( $u['href'] ) ? $u['href'] : '' ) : (string) $u;
					foreach ( $remove as $r ) {
						if ( '' !== $r && false !== strpos( $href, $r ) ) {
							return false;
						}
					}
					return true;
				}
			)
		);
		if ( 'preconnect' === $relation ) {
			foreach ( array_slice( isset( $s['preconnect'] ) ? (array) $s['preconnect'] : array(), 0, 3 ) as $origin ) {
				$urls[] = array(
					'href'        => $origin,
					'crossorigin' => 'anonymous',
				);
			}
		}
		if ( 'dns-prefetch' === $relation ) {
			foreach ( isset( $s['dnsPrefetch'] ) ? (array) $s['dnsPrefetch'] : array() as $origin ) {
				$urls[] = $origin;
			}
		}
		return $urls;
	},
	20,
	2
);
