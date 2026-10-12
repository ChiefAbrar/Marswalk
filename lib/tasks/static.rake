require "fileutils"

namespace :static do
  desc "Render the app to dist/ so it can be hosted on any static host (Vercel, Netlify, GitHub Pages)"
  task export: :environment do
    dist = Rails.root.join("dist")
    FileUtils.rm_rf(dist)
    FileUtils.mkdir_p(dist)

    html = ApplicationController.render(template: "home/index", layout: "application")
    File.write(dist.join("index.html"), html)
    FileUtils.cp_r(Dir[Rails.root.join("public", "*").to_s], dist)

    puts "Static site written to #{dist} (#{Dir[dist.join('**', '*')].count { |f| File.file?(f) }} files)"
  end
end
