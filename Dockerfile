FROM ruby:3.3-slim
RUN apt-get update -qq && apt-get install -y --no-install-recommends build-essential libyaml-dev git \
 && rm -rf /var/lib/apt/lists/*
ENV RAILS_ENV=production BUNDLE_WITHOUT="development:test" PORT=3000
WORKDIR /app
COPY Gemfile Gemfile.lock* ./
RUN bundle install --jobs 4
COPY . .
EXPOSE 3000
CMD ["bundle", "exec", "puma", "-C", "config/puma.rb"]
