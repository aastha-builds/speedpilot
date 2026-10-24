<?php
/**
 * Module third-parties (SPEC.md 8.1, 3P-01, 3P-04, VID-02): load an allowlist of third-party scripts on first
 * interaction or idle, never before consent where a consent tool exists, and click-to-load facades for YouTube, Vimeo
 * and Google Maps embeds. Every delayed handle needs an X-ray `safe` verdict for `delay` first.
 *
 * Settings: delay {handle: interaction|idle}, consentGlobal (dotted path that must be truthy before delayed scripts
 * load, for example "Cookiebot.consent.marketing"), facades {youtube, vimeo, maps} booleans.
 *
 * @package speedpilot-agent
 */

defined( 'ABSPATH' ) || exit;

require_once SPEEDPILOT_AGENT_DIR . '/includes/class-speedpilot-html.php';

add_filter(
	'script_loader_tag',
	function ( $tag, $handle ) {
		if ( ! SpeedPilot_Flags::enabled( 'third-parties' ) ) {
			return $tag;
		}
		$s     = SpeedPilot_Flags::settings( 'third-parties' );
		$delay = isset( $s['delay'] ) ? (array) $s['delay'] : array();
		if ( ! isset( $delay[ $handle ] ) ) {
			return $tag;
		}
		$p = new WP_HTML_Tag_Processor( $tag );
		while ( $p->next_tag( 'SCRIPT' ) ) {
			if ( null === $p->get_attribute( 'src' ) ) {
				continue;
			}
			$p->set_attribute( 'type', 'text/speedpilot-delayed' );
			$p->set_attribute( 'data-speedpilot-delay', 'idle' === $delay[ $handle ] ? 'idle' : 'interaction' );
		}
		$GLOBALS['speedpilot_delayed'] = true;
		return $p->get_updated_html();
	},
	20,
	2
);

add_action(
	'wp_footer',
	function () {
		if ( empty( $GLOBALS['speedpilot_delayed'] ) ) {
			return;
		}
		$s       = SpeedPilot_Flags::settings( 'third-parties' );
		$consent = isset( $s['consentGlobal'] ) ? preg_replace( '/[^A-Za-z0-9_.$]/', '', (string) $s['consentGlobal'] ) : '';
		$js      = '(function(){var c=' . wp_json_encode( $consent ) . ';function ok(){if(!c)return true;var o=window;var p=c.split(".");for(var i=0;i<p.length;i++){if(o==null)return false;o=o[p[i]];}return !!o;}'
			. 'function run(kind){if(!ok())return false;document.querySelectorAll(\'script[type="text/speedpilot-delayed"]\'+(kind?\'[data-speedpilot-delay="\'+kind+\'"]\':\'\')).forEach(function(o){var n=document.createElement("script");for(var i=0;i<o.attributes.length;i++){var a=o.attributes[i];if(a.name!=="type"&&a.name!=="data-speedpilot-delay")n.setAttribute(a.name,a.value);}n.async=false;o.parentNode.replaceChild(n,o);});return true;}'
			. 'var evs=["pointerdown","keydown","touchstart","scroll","mousemove"];function go(){if(run())evs.forEach(function(e){removeEventListener(e,go,{passive:true});});}evs.forEach(function(e){addEventListener(e,go,{passive:true});});'
			. 'var idle=window.requestIdleCallback||function(f){setTimeout(f,2000);};addEventListener("load",function(){idle(function(){run("idle");});});})();';
		echo '<script id="speedpilot-delay-loader">' . $js . "</script>\n"; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
	},
	99
);

SpeedPilot_Html::add(
	function ( $html ) {
		if ( ! SpeedPilot_Flags::enabled( 'third-parties' ) ) {
			return $html;
		}
		$s  = SpeedPilot_Flags::settings( 'third-parties' );
		$fs = isset( $s['facades'] ) ? (array) $s['facades'] : array();
		if ( empty( $fs ) ) {
			return $html;
		}
		$p     = new WP_HTML_Tag_Processor( $html );
		$found = 0;
		while ( $p->next_tag( 'IFRAME' ) ) {
			$src  = (string) $p->get_attribute( 'src' );
			$kind = '';
			if ( ! empty( $fs['youtube'] ) && preg_match( '#^https?://(www\.)?(youtube\.com|youtube-nocookie\.com)/embed/#', $src ) ) {
				$kind = 'YouTube video';
			} elseif ( ! empty( $fs['vimeo'] ) && preg_match( '#^https?://player\.vimeo\.com/video/#', $src ) ) {
				$kind = 'Vimeo video';
			} elseif ( ! empty( $fs['maps'] ) && preg_match( '#^https?://(www\.)?google\.[a-z.]+/maps/embed#', $src ) ) {
				$kind = 'map';
			}
			if ( '' === $kind ) {
				continue;
			}
			// keep the iframe markup but park its src; the facade button restores it on click
			$title = (string) $p->get_attribute( 'title' );
			$p->set_attribute( 'data-speedpilot-src', $src );
			$p->set_attribute( 'src', 'about:blank' );
			$p->set_attribute( 'data-speedpilot-facade', $kind );
			$p->set_attribute( 'aria-label', '' !== $title ? $title : $kind );
			$p->set_attribute( 'style', 'display:none' );
			++$found;
		}
		if ( ! $found ) {
			return $html;
		}
		$html = $p->get_updated_html();
		$js   = '<style>.speedpilot-facade{display:flex;align-items:center;justify-content:center;width:100%;aspect-ratio:16/9;background:#111;color:#fff;border:0;font:inherit;cursor:pointer}</style>'
			. '<script id="speedpilot-facades">document.querySelectorAll("iframe[data-speedpilot-facade]").forEach(function(f){var b=document.createElement("button");b.type="button";b.className="speedpilot-facade";b.textContent="▶ Play "+f.getAttribute("data-speedpilot-facade");b.addEventListener("click",function(){var u=f.getAttribute("data-speedpilot-src");f.src=u+(u.indexOf("?")>-1?"&":"?")+"autoplay=1";f.style.display="";b.remove();});f.parentNode.insertBefore(b,f);});</script>';
		$pos  = strripos( $html, '</body>' );
		return false === $pos ? $html . $js : substr( $html, 0, $pos ) . $js . substr( $html, $pos );
	},
	8
);
