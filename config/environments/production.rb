require "active_support/core_ext/integer/time"

Rails.application.configure do
  config.enable_reloading = false
  config.eager_load = true
  config.consider_all_requests_local = false

  # No sessions or encrypted cookies are used, but Rails still wants a key.
  # Set SECRET_KEY_BASE in your host's dashboard; a random one is used otherwise.
  config.secret_key_base = ENV["SECRET_KEY_BASE"].presence || SecureRandom.hex(64)

  config.public_file_server.enabled = true
  config.force_ssl = ENV["FORCE_SSL"] == "true"

  config.log_tags = [:request_id]
  config.logger = ActiveSupport::TaggedLogging.new(ActiveSupport::Logger.new($stdout))
  config.log_level = ENV.fetch("RAILS_LOG_LEVEL", "info").to_sym
  config.active_support.report_deprecations = false
end
