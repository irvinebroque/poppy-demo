# anti-slop provenance

Source: https://github.com/dmmulroy/anti-slop
Commit: 13909c9e07590f5a85d93c62712259fe14a883f7
Installed from: skills/install-anti-slop/assets/anti-slop/
Installed at: tools/oxlint/anti-slop/

Local adaptation: imports of @oxlint/plugins use vite-plus/lint/plugins,
which re-exports the API matching Vite+'s bundled Oxlint. All generic rules
are enabled as errors in the root vite.config.ts. Effect rules are retained
but not enabled because this project has no direct Effect dependency.
The nested eslint-stylistic license and provenance are preserved.
