<?php
/**
 * Fallback template (blog, archives).
 *
 * @package speedpilot-fixture
 */

get_header();
?>
<main class="content">
	<?php
	if ( have_posts() ) {
		while ( have_posts() ) {
			the_post();
			echo '<article><h2><a href="' . esc_url( get_permalink() ) . '">' . esc_html( get_the_title() ) . '</a></h2>';
			the_excerpt();
			echo '</article>';
		}
		the_posts_pagination();
	} else {
		echo '<p>Nothing found.</p>';
	}
	?>
</main>
<?php
get_footer();
