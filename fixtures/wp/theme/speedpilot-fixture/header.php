<?php
/**
 * Header.
 *
 * @package speedpilot-fixture
 */
?><!doctype html>
<html <?php language_attributes(); ?>>
<head>
<meta charset="<?php bloginfo( 'charset' ); ?>">
<meta name="viewport" content="width=device-width, initial-scale=1">
<?php wp_head(); ?>
</head>
<body <?php body_class(); ?>>
<?php wp_body_open(); ?>
<div id="preloader">Loading&hellip;</div><?php // PLANTED DOC-03 ?>
<header class="site-header">
	<a class="logo" href="<?php echo esc_url( home_url( '/' ) ); ?>">SpeedPilot Fixture</a>
	<button class="menu-toggle" aria-expanded="false" aria-controls="primary-nav">Menu</button>
	<nav id="primary-nav" class="main-nav">
		<ul>
			<li><a href="<?php echo esc_url( home_url( '/' ) ); ?>">Home</a></li>
			<li><a href="<?php echo esc_url( home_url( '/shop/' ) ); ?>">Shop</a></li>
			<li><a href="<?php echo esc_url( home_url( '/blog/' ) ); ?>">Blog</a></li>
			<li><a href="<?php echo esc_url( home_url( '/contact/' ) ); ?>">Contact</a></li>
			<li><a href="<?php echo esc_url( home_url( '/cart/' ) ); ?>" class="cart-link">Cart</a></li>
		</ul>
	</nav>
</header>
