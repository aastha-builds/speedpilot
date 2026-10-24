<?php
/**
 * Authentication for diagnostics: Application Password (REST) plus manage_options, or an HMAC token that expires in
 * minutes. There are no public toggles.
 *
 * @package speedpilot-agent
 */

defined( 'ABSPATH' ) || exit;

/**
 * Auth helpers.
 */
class SpeedPilot_Auth {

	const MAX_TTL = 300;

	/**
	 * HMAC secret from wp-config.php (SPEEDPILOT_HMAC_SECRET). Never stored in the database.
	 *
	 * @return string
	 */
	public static function secret() {
		return defined( 'SPEEDPILOT_HMAC_SECRET' ) ? (string) SPEEDPILOT_HMAC_SECRET : '';
	}

	/**
	 * Validates the X-SpeedPilot-Token header: "<expires>.<scope>.<hex hmac-sha256 of 'expires.scope'>".
	 *
	 * @param string $scope Expected scope (diag, timing).
	 * @return bool
	 */
	public static function token_valid( $scope = 'diag' ) {
		$secret = self::secret();
		if ( strlen( $secret ) < 16 ) {
			return false;
		}
		$header = isset( $_SERVER['HTTP_X_SPEEDPILOT_TOKEN'] ) ? (string) wp_unslash( $_SERVER['HTTP_X_SPEEDPILOT_TOKEN'] ) : ''; // phpcs:ignore WordPress.Security.ValidatedSanitizedInput
		$parts  = explode( '.', $header );
		if ( 3 !== count( $parts ) ) {
			return false;
		}
		list( $expires, $tok_scope, $mac ) = $parts;
		$expires = (int) $expires;
		$now     = time();
		if ( $expires < $now || $expires > $now + self::MAX_TTL ) {
			return false;
		}
		if ( $tok_scope !== $scope && 'all' !== $tok_scope ) {
			return false;
		}
		$expected = hash_hmac( 'sha256', $expires . '.' . $tok_scope, $secret );
		return hash_equals( $expected, (string) $mac );
	}

	/**
	 * REST permission callback: Application Password user with manage_options, or a valid token.
	 *
	 * @return bool|WP_Error
	 */
	public static function rest_permission() {
		if ( self::token_valid( 'diag' ) ) {
			return true;
		}
		if ( current_user_can( 'manage_options' ) ) {
			return true;
		}
		return new WP_Error( 'speedpilot_forbidden', 'Authentication required.', array( 'status' => is_user_logged_in() ? 403 : 401 ) );
	}

	/**
	 * Is this environment allowed to run staging-only diagnostics (SAVEQUERIES, HTTP call log)?
	 * Never production (CLAUDE.md rule 12).
	 *
	 * @return bool
	 */
	public static function staging_diagnostics_allowed() {
		$type = function_exists( 'wp_get_environment_type' ) ? wp_get_environment_type() : 'production';
		return in_array( $type, array( 'local', 'development', 'staging' ), true );
	}
}
