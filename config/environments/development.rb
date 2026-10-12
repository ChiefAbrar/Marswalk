require "active_support/core_ext/integer/time"

Rails.application.configure do
  config.enable_reloading = true
  config.eager_load = false
  config.consider_all_requests_local = true
  config.server_timing = true
  config.public_file_server.headers = { "Cache-Control" => "no-cache" }
  config.active_support.deprecation = :log
  config.action_controller.raise_on_missing_callback_actions = true
end
