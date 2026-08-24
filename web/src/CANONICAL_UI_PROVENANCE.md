# Messenger UI scope

The messenger presentation, shared CSS cascade, icons, QR surfaces, message/media
renderers, Markdown/HTML viewers, image compression, and pure UI helpers are
maintained in this repository as the standalone messenger interface.

All browser state and mutations go through this repository's same-origin REST/SSE
adapter. Browser SDK runtimes, identity backup, fleet monitoring, agent management,
and MCP surfaces are outside the messenger interface's scope.
