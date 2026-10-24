<?php
/**
 * Module interaction-yield (SPEC.md 8.1, JS-04, REV-07): for event handlers the X-ray timed at more than 100 ms, let
 * the browser paint the interaction first and run the handler right after (requestAnimationFrame, then a task). Only
 * for handlers that never call preventDefault or stopPropagation (checked by SpeedPilot before the flag goes on), so
 * behaviour is the same, just after the next paint. The theme and plugin files stay untouched.
 *
 * Settings: handlers[] {name (function name), type (event type)}.
 *
 * @package speedpilot-agent
 */

defined( 'ABSPATH' ) || exit;

add_action(
	'wp_head',
	function () {
		if ( ! SpeedPilot_Flags::enabled( 'interaction-yield' ) ) {
			return;
		}
		$s     = SpeedPilot_Flags::settings( 'interaction-yield' );
		$names = array();
		foreach ( isset( $s['handlers'] ) ? (array) $s['handlers'] : array() as $h ) {
			if ( ! empty( $h['name'] ) && preg_match( '/^[A-Za-z_$][\w$]*$/', $h['name'] ) ) {
				$type             = ! empty( $h['type'] ) ? preg_replace( '/[^a-z]/', '', strtolower( $h['type'] ) ) : 'click';
				$names[ $type ][] = $h['name'];
			}
		}
		if ( empty( $names ) ) {
			return;
		}
		$js = '(function(n){var P=EventTarget.prototype,add=P.addEventListener,rem=P.removeEventListener;'
			. 'P.addEventListener=function(t,f,o){if(typeof f==="function"&&n[t]&&n[t].indexOf(f.name)>-1){if(!f.__spYield){f.__spYield=function(e){var s=this;requestAnimationFrame(function(){setTimeout(function(){f.call(s,e);},0);});};}return add.call(this,t,f.__spYield,o);}return add.call(this,t,f,o);};'
			. 'P.removeEventListener=function(t,f,o){return rem.call(this,t,f&&f.__spYield?f.__spYield:f,o);};})(' . wp_json_encode( $names ) . ');';
		echo '<script id="speedpilot-interaction-yield">' . $js . "</script>\n"; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
	},
	0
);
