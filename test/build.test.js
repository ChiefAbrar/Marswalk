import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
const root = new URL("../", import.meta.url).pathname;
const read = p => readFileSync(join(root, p), "utf8");
const walk = d => readdirSync(join(root, d)).flatMap(f => statSync(join(root, d, f)).isDirectory() ? walk(join(d, f)).map(x => x) : [join(d, f)]);

test("dist/ is exactly what the build produces from the Rails layout, view and public/", () => {
  const layout = read("app/views/layouts/application.html.erb"), view = read("app/views/home/index.html.erb");
  assert.equal(read("dist/index.html"), layout.replace("<%= yield %>", view));
  for (const f of walk("public")) assert.equal(readFileSync(join(root, "dist", f.replace(/^public\//, ""))).equals(readFileSync(join(root, f))), true, `dist copy of ${f} differs`);
});

test("Vercel config serves dist/ and does not allow third-party scripts or connections", () => {
  const v = JSON.parse(read("vercel.json"));
  assert.equal(v.outputDirectory, "dist");
  const csp = v.headers[0].headers.find(h => h.key === "Content-Security-Policy").value;
  assert.match(csp, /script-src 'self'(;|$)/); assert.match(csp, /connect-src 'self'(;|$)/);
  assert.doesNotMatch(csp, /https?:\/\//);
});

test("app code makes no requests to external hosts", () => {
  for (const f of walk("public/js")) assert.doesNotMatch(read(f).replace(/href: "https?:[^"]*"/g, "").replace(/https?:\/\/(doi\.org|www\.giss|pds-geo|www\.uahirise)[^"'\s)]*/g, ""), /fetch\(\s*["']https?:/, f);
});

test("Rails static export task and Dockerfile reference files that exist", () => {
  assert.ok(existsSync(join(root, "lib/tasks/static.rake")));
  const d = read("Dockerfile"); assert.match(d, /COPY Gemfile Gemfile\.lock/);
  assert.match(read("render.yaml"), /healthCheckPath: \/up/);
  assert.match(read("config/routes.rb"), /get "up"/);
});

test("licence and required documentation files are present", () => {
  for (const f of ["LICENSE", "README.md", "DATA_SOURCES.md", "AI_USAGE.md"]) assert.ok(existsSync(join(root, f)), f);
});
