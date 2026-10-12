Rails.application.routes.draw do
  # Load-balancer / uptime check (returns 200 when the app boots cleanly).
  get "up" => "rails/health#show", as: :rails_health_check

  root "home#index"
end
