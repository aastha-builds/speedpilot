<?php
/**
 * Plugin Name: SpeedPilot Fixture Planter
 * Description: Plants the SPEC.md section 11 problems into the local fixture site. Local fixtures only; never install on a real site.
 * Version: 1.0.0
 *
 * @package speedpilot-fixture
 */

defined( 'ABSPATH' ) || exit;

// The sandbox has no route to WordPress.org: skip core, plugin and theme update checks so their failures do not show up
// as PHP warnings in the backend guard. Local fixture only.
foreach ( array( 'update_core', 'update_plugins', 'update_themes' ) as $speedpilot_fixture_transient ) {
	add_filter(
		'pre_site_transient_' . $speedpilot_fixture_transient,
		function () {
			return (object) array(
				'last_checked'    => time(),
				'version_checked' => get_bloginfo( 'version' ),
				'updates'         => array(),
				'response'        => array(),
				'translations'    => array(),
			);
		}
	);
}

if ( ! defined( 'WP_CLI' ) || ! WP_CLI ) {
	return;
}

/**
 * `wp spf plant` and `wp spf planted`.
 */
class SPF_Fixture_Command {

	/**
	 * Plants every problem and writes the planted list.
	 *
	 * @param array $args       Positional args.
	 * @param array $assoc_args Assoc args.
	 */
	public function plant( $args, $assoc_args ) {
		$planted = array();

		update_option( 'blogname', 'SpeedPilot Fixture' );
		update_option( 'permalink_structure', '/%postname%/' );

		// Pages.
		$home    = $this->page( 'Home', '<p>Home page content.</p>' );
		$blog    = $this->page( 'Blog', '' );
		$form    = $this->cf7_form();
		$contact = $this->page( 'Contact', $form ? '[contact-form-7 id="' . $form . '" title="Contact"]' : '<p>Contact us.</p>' );
		$this->page( 'About', '<p>About us. This page has no form, no slider and no products.</p>' );
		update_option( 'show_on_front', 'page' );
		update_option( 'page_on_front', $home );
		update_option( 'page_for_posts', $blog );

		// Posts with the rating meta the slow query reads.
		for ( $i = 1; $i <= 12; $i++ ) {
			$id = $this->post( 'Fixture post ' . $i, str_repeat( '<p>Lorem ipsum dolor sit amet. </p>', 8 ) );
			update_post_meta( $id, '_spf_rating', $i % 5 );
		}

		// Products (WooCommerce).
		if ( class_exists( 'WooCommerce' ) ) {
			$planted[] = $this->products();
			if ( function_exists( 'wc_get_page_id' ) ) {
				WC_Install::create_pages();
			}
		}

		// PLANTED WPB-04: about 2 MB of autoloaded options, with owners by prefix, including a leftover from a deleted plugin.
		$chunk = str_repeat( 'x', 100 * 1024 );
		for ( $i = 1; $i <= 12; $i++ ) {
			update_option( 'smartslider_cache_' . $i, $chunk, true );
		}
		update_option( 'oldstats_plugin_data', str_repeat( 'y', 600 * 1024 ), true );
		update_option( 'elementor_remote_info_cache', str_repeat( 'z', 300 * 1024 ), true );
		$planted[] = array(
			'id'     => 'autoload-bloat',
			'checks' => array( 'WPB-04' ),
			'detail' => 'about 2.1 MB autoloaded: smartslider_cache_1..12 (100 KB each, Smart Slider), oldstats_plugin_data (600 KB, deleted plugin), elementor_remote_info_cache (300 KB, Elementor)',
		);

		// Expired transients (WPB-05).
		for ( $i = 1; $i <= 50; $i++ ) {
			update_option( '_transient_timeout_spf_old_' . $i, time() - 3600, false );
			update_option( '_transient_spf_old_' . $i, 'stale', false );
		}

		// Menu.
		$menu_id = wp_create_nav_menu( 'Primary ' . wp_generate_password( 4, false ) );
		if ( ! is_wp_error( $menu_id ) ) {
			wp_update_nav_menu_item( $menu_id, 0, array( 'menu-item-title' => 'Contact', 'menu-item-object-id' => $contact, 'menu-item-object' => 'page', 'menu-item-type' => 'post_type', 'menu-item-status' => 'publish' ) );
			set_theme_mod( 'nav_menu_locations', array( 'primary' => $menu_id ) );
		}

		flush_rewrite_rules();

		$list = array(
			'generatedAt' => gmdate( 'c' ),
			'plugins'     => array_values( array_map( 'basename', array_map( 'dirname', array_keys( get_plugins() ) ) ) ),
			'pages'       => array( 'home' => $home, 'contact' => $contact, 'blog' => $blog ),
			'extra'       => $planted,
		);
		$upload = wp_upload_dir();
		wp_mkdir_p( $upload['basedir'] );
		file_put_contents( $upload['basedir'] . '/speedpilot-fixture-planted.json', wp_json_encode( $list, JSON_PRETTY_PRINT ) ); // phpcs:ignore WordPress.WP.AlternativeFunctions
		WP_CLI::success( 'Planted. List: ' . $upload['basedir'] . '/speedpilot-fixture-planted.json' );
	}

	/**
	 * Creates or finds a page.
	 *
	 * @param string $title   Title.
	 * @param string $content Content.
	 * @return int
	 */
	private function page( $title, $content ) {
		$existing = get_page_by_path( sanitize_title( $title ) );
		if ( $existing ) {
			wp_update_post( array( 'ID' => $existing->ID, 'post_content' => $content ) );
			return (int) $existing->ID;
		}
		return (int) wp_insert_post( array( 'post_type' => 'page', 'post_status' => 'publish', 'post_title' => $title, 'post_content' => $content ) );
	}

	/**
	 * Creates a post.
	 *
	 * @param string $title   Title.
	 * @param string $content Content.
	 * @return int
	 */
	private function post( $title, $content ) {
		$existing = get_page_by_path( sanitize_title( $title ), OBJECT, 'post' );
		if ( $existing ) {
			return (int) $existing->ID;
		}
		return (int) wp_insert_post( array( 'post_type' => 'post', 'post_status' => 'publish', 'post_title' => $title, 'post_content' => $content ) );
	}

	/**
	 * Creates a Contact Form 7 form when CF7 (or its stand-in) is active.
	 *
	 * @return int|null
	 */
	private function cf7_form() {
		if ( ! post_type_exists( 'wpcf7_contact_form' ) ) {
			return null;
		}
		$found = get_posts( array( 'post_type' => 'wpcf7_contact_form', 'numberposts' => 1 ) );
		if ( $found ) {
			return (int) $found[0]->ID;
		}
		$id = wp_insert_post(
			array(
				'post_type'   => 'wpcf7_contact_form',
				'post_status' => 'publish',
				'post_title'  => 'Contact',
			)
		);
		update_post_meta( $id, '_form', '[text* your-name] [email* your-email] [textarea your-message] [submit "Send"]' );
		return (int) $id;
	}

	/**
	 * Creates simple and variable products.
	 *
	 * @return array
	 */
	private function products() {
		$ids = array();
		for ( $i = 1; $i <= 6; $i++ ) {
			$existing = get_page_by_path( 'fixture-product-' . $i, OBJECT, 'product' );
			if ( $existing ) {
				$ids[] = $existing->ID;
				continue;
			}
			$p = new WC_Product_Simple();
			$p->set_name( 'Fixture product ' . $i );
			$p->set_slug( 'fixture-product-' . $i );
			$p->set_regular_price( (string) ( 10 * $i ) );
			$p->set_status( 'publish' );
			$ids[] = $p->save();
		}
		if ( ! get_page_by_path( 'fixture-variable', OBJECT, 'product' ) ) {
			$attr = new WC_Product_Attribute();
			$attr->set_name( 'Size' );
			$attr->set_options( array( 'S', 'M', 'L', 'XL' ) );
			$attr->set_visible( true );
			$attr->set_variation( true );
			$v = new WC_Product_Variable();
			$v->set_name( 'Fixture variable' );
			$v->set_slug( 'fixture-variable' );
			$v->set_attributes( array( $attr ) );
			$v->set_status( 'publish' );
			$vid = $v->save();
			foreach ( array( 'S', 'M', 'L', 'XL' ) as $size ) {
				$var = new WC_Product_Variation();
				$var->set_parent_id( $vid );
				$var->set_attributes( array( 'size' => $size ) );
				$var->set_regular_price( '25' );
				$var->save();
			}
			$ids[] = $vid;
		}
		return array( 'id' => 'products', 'checks' => array(), 'detail' => 'products ' . implode( ',', $ids ) );
	}
}

WP_CLI::add_command( 'spf', 'SPF_Fixture_Command' );
