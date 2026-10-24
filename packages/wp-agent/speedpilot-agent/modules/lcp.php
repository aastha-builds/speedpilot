<?php
/**
 * Module lcp (SPEC.md 8.1, IMG-01, WPF-15): keep the LCP image out of lazy loading, add fetchpriority="high" and
 * preload it with imagesrcset and imagesizes through wp_preload_resources. Never used together with Image Prioritizer
 * (WPF-21).
 *
 * Settings: match (image URL fragment), preload (bool), href, imagesrcset, imagesizes, rules.
 *
 * @package speedpilot-agent
 */

defined( 'ABSPATH' ) || exit;

require_once SPEEDPILOT_AGENT_DIR . '/includes/class-speedpilot-html.php';

/**
 * The LCP image settings for this request, or null.
 *
 * @return array|null
 */
function speedpilot_lcp_settings() {
	if ( ! SpeedPilot_Flags::enabled( 'lcp' ) ) {
		return null;
	}
	$s = SpeedPilot_Flags::settings( 'lcp' );
	if ( empty( $s['match'] ) || ! SpeedPilot_Flags::rules_match( isset( $s['rules'] ) ? (array) $s['rules'] : array() ) ) {
		return null;
	}
	return $s;
}

add_filter(
	'wp_preload_resources',
	function ( $resources ) {
		$s = speedpilot_lcp_settings();
		if ( ! $s || empty( $s['preload'] ) || empty( $s['href'] ) ) {
			return $resources;
		}
		$r = array(
			'href'          => $s['href'],
			'as'            => 'image',
			'fetchpriority' => 'high',
		);
		if ( ! empty( $s['imagesrcset'] ) ) {
			$r['imagesrcset'] = $s['imagesrcset'];
			$r['imagesizes']  = ! empty( $s['imagesizes'] ) ? $s['imagesizes'] : '100vw';
		}
		$resources[] = $r;
		return $resources;
	}
);

SpeedPilot_Html::add(
	function ( $html ) {
		$s = speedpilot_lcp_settings();
		if ( ! $s ) {
			return $html;
		}
		$p = new WP_HTML_Tag_Processor( $html );
		while ( $p->next_tag( 'IMG' ) ) {
			$src = (string) $p->get_attribute( 'src' );
			if ( false === strpos( $src, $s['match'] ) ) {
				continue;
			}
			$p->remove_attribute( 'loading' );
			$p->set_attribute( 'fetchpriority', 'high' );
			$p->set_attribute( 'decoding', 'async' );
			break;
		}
		return $p->get_updated_html();
	},
	5
);
