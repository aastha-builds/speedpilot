<?php
/**
 * Module css (SPEC.md 8.1, CSS-01 to CSS-09): critical CSS per template (generated on staging from rule coverage and
 * regenerated whenever the theme changes), full stylesheets loaded async (print-media swap plus noscript) only where
 * critical CSS exists, and whole files coverage proves unused on a template removed.
 *
 * Settings: critical {template: css}, async[] (style handles), remove[] {handle, rules}, themeVersion (critical CSS is
 * ignored when the active theme version differs), extraCss (SpeedPilot-authored fixes, for example no entrance animation
 * above the fold (DOC-04) or space reserved for a late banner (CLS-03); printed after the stylesheets).
 *
 * @package speedpilot-agent
 */

defined( 'ABSPATH' ) || exit;

/**
 * Critical CSS for this template, or ''.
 *
 * @return string
 */
function speedpilot_critical_css() {
	if ( ! SpeedPilot_Flags::enabled( 'css' ) ) {
		return '';
	}
	$s = SpeedPilot_Flags::settings( 'css' );
	if ( ! empty( $s['themeVersion'] ) && wp_get_theme()->get( 'Version' ) !== $s['themeVersion'] ) {
		return ''; // the theme changed: stale critical CSS would break the first paint
	}
	$tpl = SpeedPilot_Flags::template();
	return isset( $s['critical'][ $tpl ] ) ? (string) $s['critical'][ $tpl ] : '';
}

add_action(
	'wp_enqueue_scripts',
	function () {
		if ( ! SpeedPilot_Flags::enabled( 'css' ) ) {
			return;
		}
		$s = SpeedPilot_Flags::settings( 'css' );
		foreach ( isset( $s['remove'] ) ? (array) $s['remove'] : array() as $item ) {
			if ( ! empty( $item['handle'] ) && SpeedPilot_Flags::rules_match( isset( $item['rules'] ) ? (array) $item['rules'] : array() ) ) {
				wp_dequeue_style( $item['handle'] );
			}
		}
	},
	9999
);

add_action(
	'wp_head',
	function () {
		$css = speedpilot_critical_css();
		if ( '' !== $css ) {
			echo '<style id="speedpilot-critical-css">' . str_replace( '</', '<\/', $css ) . "</style>\n"; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
		}
	},
	1
);

add_action(
	'wp_head',
	function () {
		if ( ! SpeedPilot_Flags::enabled( 'css' ) ) {
			return;
		}
		$s = SpeedPilot_Flags::settings( 'css' );
		if ( ! empty( $s['extraCss'] ) ) {
			echo '<style id="speedpilot-css-fixes">' . str_replace( '</', '<\/', (string) $s['extraCss'] ) . "</style>\n"; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
		}
	},
	100
);

add_filter(
	'style_loader_tag',
	function ( $tag, $handle ) {
		$s = SpeedPilot_Flags::settings( 'css' );
		if ( empty( $s['async'] ) || ! in_array( $handle, (array) $s['async'], true ) || '' === speedpilot_critical_css() ) {
			return $tag;
		}
		$p = new WP_HTML_Tag_Processor( $tag );
		if ( ! $p->next_tag( 'LINK' ) || 'stylesheet' !== $p->get_attribute( 'rel' ) ) {
			return $tag;
		}
		$media = (string) $p->get_attribute( 'media' );
		$media = '' === $media ? 'all' : $media;
		$p->set_attribute( 'media', 'print' );
		$p->set_attribute( 'onload', "this.media='" . esc_js( $media ) . "';this.onload=null" );
		return $p->get_updated_html() . '<noscript>' . $tag . '</noscript>';
	},
	20,
	2
);
