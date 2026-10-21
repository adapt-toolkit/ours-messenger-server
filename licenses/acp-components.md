# ACP interface

Fleet embeds MessageBubble (including tool-call visualization and Markdown) and StreamingIndicator from @acp-components/react **0.1.0**, with @acp-components/core **0.1.0** types. Exact npm versions/integrity hashes are pinned in package-lock.json.

Upstream: https://github.com/zvzuola/acp-components (MIT; copyright 2026 acp-components contributors). See acp-components-MIT.txt.

Fleet supplies the HTTP conversation adapter, authentication, prompt/interrupt controls and exact permission decisions. No independent ACP agent connection or identity is created by this UI library. Fleet redacted events are omitted; run indicators use session/queue/permission state. CSS tokens adapt the components to Fleet colors.
