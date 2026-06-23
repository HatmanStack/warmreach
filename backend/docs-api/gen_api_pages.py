"""Generate one mkdocstrings reference page per shared-services module.

Run automatically by the mkdocs-gen-files plugin during `mkdocs build`. Walks
`lambdas/shared/python/shared_services`, emits a Markdown page per module with a
single `::: shared_services.<module>` autodoc directive, and writes a
`SUMMARY.md` consumed by the literate-nav plugin. No module list is hardcoded,
so new shared services appear in the generated docs without edits here.
"""

from pathlib import Path

import mkdocs_gen_files

PACKAGE = "shared_services"
SRC_ROOT = Path("lambdas/shared/python") / PACKAGE

nav = mkdocs_gen_files.Nav()

for path in sorted(SRC_ROOT.glob("*.py")):
    module = path.stem
    if module == "__init__":
        continue

    doc_path = Path("reference", f"{module}.md")
    nav[module] = doc_path.as_posix()

    with mkdocs_gen_files.open(doc_path, "w") as fd:
        fd.write(f"# `{PACKAGE}.{module}`\n\n")
        fd.write(f"::: {PACKAGE}.{module}\n")

    mkdocs_gen_files.set_edit_path(doc_path, path)

with mkdocs_gen_files.open("SUMMARY.md", "w") as nav_file:
    nav_file.write("* [Overview](index.md)\n")
    nav_file.writelines(nav.build_literate_nav())
