<?php
/**
 * Module plugin-woocommerce (SPEC.md 8.1, WPF-07, WOO-01): cart fragments only where a live mini-cart needs them,
 * and WooCommerce front-end assets only on shop pages and pages that show products. Never touches checkout scripts.
 *
 * Settings: cartFragments {keep: rules}, assetsOnlyOnShop (bool), keepAssets (rules for non-shop pages with products).
 *
 * @package speedpilot-agent
 */

defined( 'ABSPATH' ) || exit;

add_action(
	'wp_enqueue_scripts',
	function () {
		if ( ! SpeedPilot_Flags::enabled( 'plugin-woocommerce' ) || ! function_exists( 'is_woocommerce' ) ) {
			return;
		}
		$s    = SpeedPilot_Flags::settings( 'plugin-woocommerce' );
		$shop = is_woocommerce() || is_cart() || is_checkout() || is_account_page();
		if ( isset( $s['cartFragments'] ) && ! is_cart() && ! is_checkout() ) {
			$keep = isset( $s['cartFragments']['keep'] ) ? (array) $s['cartFragments']['keep'] : array();
			if ( empty( $keep ) || ! SpeedPilot_Flags::rules_match( $keep ) ) {
				wp_dequeue_script( 'wc-cart-fragments' );
			}
		}
		if ( ! empty( $s['assetsOnlyOnShop'] ) && ! $shop && ! ( ! empty( $s['keepAssets'] ) && SpeedPilot_Flags::rules_match( (array) $s['keepAssets'] ) ) ) {
			foreach ( array( 'woocommerce-general', 'woocommerce-layout', 'woocommerce-smallscreen', 'wc-blocks-style' ) as $h ) {
				wp_dequeue_style( $h );
			}
			foreach ( array( 'woocommerce', 'wc-add-to-cart', 'js-cookie', 'wc-js-cookie', 'jquery-blockui', 'wc-jquery-blockui' ) as $h ) {
				wp_dequeue_script( $h );
			}
		}
	},
	9999
);
