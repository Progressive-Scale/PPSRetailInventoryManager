-- Allow an http:// APK URL, not only https://.
--
-- DELIBERATE AND TEMPORARY. The APK host's TLS certificate expired in July 2022, so
-- Android refuses the handshake and self-update cannot complete. Rather than block the
-- feature, cleartext is permitted for that one host -- in the app via a scoped
-- network_security_config, in the downloader's scheme guard, and here.
--
-- The security boundary for an update is the sha256, which is unchanged: the digest is
-- delivered over a validated https connection to this API, and the scanner verifies the
-- downloaded bytes against it before anything reaches the installer. Substituted bytes
-- fail closed. Cleartext costs confidentiality and availability, not integrity.
--
-- REVERT when the certificate is renewed:
--   ALTER TABLE "app_releases" DROP CONSTRAINT "app_releases_url_http_or_https";
--   ALTER TABLE "app_releases" ADD CONSTRAINT "app_releases_url_https"
--     CHECK ("apk_url" LIKE 'https://%');
ALTER TABLE "app_releases" DROP CONSTRAINT IF EXISTS "app_releases_url_https";--> statement-breakpoint
-- Dropped first so re-running this file is harmless (it was applied by hand on dev
-- before the journal knew about it, and ADD CONSTRAINT is not idempotent).
ALTER TABLE "app_releases" DROP CONSTRAINT IF EXISTS "app_releases_url_http_or_https";--> statement-breakpoint
ALTER TABLE "app_releases" ADD CONSTRAINT "app_releases_url_http_or_https"
  CHECK ("apk_url" LIKE 'https://%' OR "apk_url" LIKE 'http://%');
