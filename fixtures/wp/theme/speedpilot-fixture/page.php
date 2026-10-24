<?php
/**
 * Page template.
 *
 * @package speedpilot-fixture
 */

get_header();
?>
<main class="content">
	<?php
	while ( have_posts() ) {
		the_post();
		echo '<h1>' . esc_html( get_the_title() ) . '</h1>';
		the_content();
	}
	?>
</main>
<?php
get_footer();
