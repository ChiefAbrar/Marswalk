#!/usr/bin/env python3
"""Builds dist/ exactly as `bin/rails static:export` does, without needing Ruby.
Use this only if you can't run Rails locally; the output is the same."""
import shutil, pathlib
root = pathlib.Path(__file__).resolve().parent.parent
layout = (root/"app/views/layouts/application.html.erb").read_text()
view = (root/"app/views/home/index.html.erb").read_text()
assert layout.count("<%= yield %>") == 1
dist = root/"dist"
shutil.rmtree(dist, ignore_errors=True); dist.mkdir()
(dist/"index.html").write_text(layout.replace("<%= yield %>", view))
for p in (root/"public").iterdir():
    shutil.copytree(p, dist/p.name) if p.is_dir() else shutil.copy(p, dist/p.name)
print("dist/ built:", sum(1 for f in dist.rglob("*") if f.is_file()), "files")
