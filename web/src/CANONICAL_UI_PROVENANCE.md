# Canonical messenger UI provenance

The messenger presentation, shared CSS cascade, icons, QR surfaces, message/media
renderers, Markdown/HTML viewers, image compression, and pure UI helpers were
copied or adapted from `adapt-toolkit/ours-control-plane` commit
`bc0183c80e9ee0ea2dd5adecb58460b0564e90d5`.

The standalone transport is not copied: all browser state and mutations continue
through this repository's same-origin REST/SSE adapter. Fleet/control, browser SDK,
WASM, seed/backup, monitoring, agent-management, and MCP code are excluded.
