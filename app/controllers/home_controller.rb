class HomeController < ApplicationController
  def index
    expires_in 5.minutes, public: true
  end
end
