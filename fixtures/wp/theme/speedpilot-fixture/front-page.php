<?php
/**
 * Front page: hero, slider, gallery, video, form, products.
 *
 * @package speedpilot-fixture
 */

get_header();
spf_hero();
$spf_related = spf_related_posts();
?>
<main class="content">
	<h2 class="animate-in">Welcome</h2>
	<p>This fixture is slow on purpose. <?php echo (int) $spf_related; ?> related items found the slow way.</p>
	<?php
	if ( shortcode_exists( 'smartslider3' ) ) {
		echo do_shortcode( '[smartslider3 slider="1"]' );
	}
	spf_gallery();
	spf_youtube();
	?>
	<details class="accordion"><summary>Shipping</summary><p>We ship everywhere.</p></details>
	<details class="accordion"><summary>Returns</summary><p>30 days.</p></details>
	<button id="heavy-button" type="button">Show offers</button>
	<div id="offers" hidden>10% off today.</div>
	<?php
	while ( have_posts() ) {
		the_post();
		the_content();
	}
	?>
</main>
<?php
get_footer();
