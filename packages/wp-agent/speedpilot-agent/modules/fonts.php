<?php
/**
 * Module fonts (SPEC.md 8.1, FONT-01 to FONT-04): self-hosted Google Fonts (woff2 files SpeedPilot placed in
 * uploads/speedpilot/fonts with only the used weights and subsets), font-display: swap, at most 2 preloads, fallback
 * metric overrides (size-adjust, ascent-override, descent-override) to cut CLS. The agent makes no outgoing calls.
 *
 * Settings: dequeue[] (style handles of the remote font CSS), css (the @font-face rules), preload[] (max 2 URLs),
 * fallbackCss (metric-override @font-face rules).
 *
 * @package speedpilot-agent
 */

defined( 'ABSPATH' ) || exit;

add_action(
	'wp_enqueue_scripts',
	function () {
		if ( ! SpeedPilot_Flags::enabled( 'fonts' ) ) {
			return;
		}
		$s = SpeedPilot_Flags::settings( 'fonts' );
		foreach ( isset( $s['dequeue'] ) ? (array) $s['dequeue'] : array() as $handle ) {
			wp_dequeue_style( $handle );
		}
	},
	9999
);

add_filter(
	'wp_preload_resources',
	function ( $resources ) {
		if ( ! SpeedPilot_Flags::enabled( 'fonts' ) ) {
			return $resources;
		}
		$s = SpeedPilot_Flags::settings( 'fonts' );
		foreach ( array_slice( isset( $s['preload'] ) ? (array) $s['preload'] : array(), 0, 2 ) as $url ) {
			$resources[] = array(
				'href'        => $url,
				'as'          => 'font',
				'type'        => 'font/woff2',
				'crossorigin' => 'anonymous',
			);
		}
		return $resources;
	}
);

add_action(
	'wp_head',
	function () {
		if ( ! SpeedPilot_Flags::enabled( 'fonts' ) ) {
			return;
		}
		$s   = SpeedPilot_Flags::settings( 'fonts' );
		$css = ( isset( $s['fallbackCss'] ) ? $s['fallbackCss'] : '' ) . ( isset( $s['css'] ) ? $s['css'] : '' );
		if ( '' === $css ) {
			return;
		}
		// The CSS is SpeedPilot-generated @font-face rules; strip anything that could close the style element.
		echo '<style id="speedpilot-fonts">' . str_replace( '</', '<\/', $css ) . "</style>\n"; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
	},
	2
);
