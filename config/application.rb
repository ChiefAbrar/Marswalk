require_relative "boot"

require "rails"
require "action_controller/railtie"
require "action_view/railtie"

Bundler.require(*Rails.groups)

module MarsSurvival
  class Application < Rails::Application
    config.load_defaults 7.1
    config.eager_load = false

    # No database, mailer, jobs or storage: this app only serves the mission-control dashboard.
    config.time_zone = "UTC"
    config.generators.system_tests = nil

    # Static assets (public/css, public/js) are served by Rails itself.
    config.public_file_server.enabled = true
    config.public_file_server.headers = { "Cache-Control" => "public, max-age=3600" }

    # Security headers. The page needs: its own JS/CSS, the optional GeoTIFF
    # library from jsDelivr, and the optional NASA HiRISE DTM download.
    csp = [
      "default-src 'self'",
      "script-src 'self' https://cdn.jsdelivr.net",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self' https://www.uahirise.org",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'"
    ].join("; ")

    config.action_dispatch.default_headers = {
      "X-Frame-Options" => "DENY",
      "X-Content-Type-Options" => "nosniff",
      "Referrer-Policy" => "strict-origin-when-cross-origin",
      "Permissions-Policy" => "camera=(), microphone=(), geolocation=()",
      "Content-Security-Policy" => csp
    }
  end
end
