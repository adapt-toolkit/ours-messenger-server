import type { Message, ToolCallState } from '@acp-components/core';
export function acpMessages(events: any[]): Message[] {
  const rows = new Map<string, Message>();
  const tools = new Map<string, ToolCallState>();
  for (const e of events) {
    const p = e.payload;
    if (e.kind === 'prompt.admitted' && ['owner_admin_console', 'local_console', 'owner_channel'].includes(e.source) && !p.text?.redacted) {
      const text = p.displayText?.text ?? p.text?.text;
      if (text) rows.set(e.promptId, { id: e.promptId, role: 'user', timestamp: Date.parse(e.at), parts: [{ type: 'content', content: [{ type: 'text', text }] }] });
    }
    if (['message.chunk', 'message.replace'].includes(e.kind) && p.content?.type === 'text') {
      const id = e.messageId ?? e.eventId;
      if (p.content.redacted) { rows.delete(id); continue; }
      const previous = rows.get(id)?.parts[0];
      const text = (e.kind === 'message.chunk' && previous?.type === 'content' && previous.content[0]?.type === 'text' ? previous.content[0].text : '') + p.content.text;
      rows.set(id, { id, role: p.role === 'user' ? 'user' : 'agent', timestamp: Date.parse(e.at), parts: [{ type: 'content', content: [{ type: 'text', text }] }] });
    }
    if (e.kind === 'tool.upsert') {
      const old = tools.get(p.toolCallId);
      const tool: ToolCallState = { ...old, toolCallId: p.toolCallId, title: p.title ?? old?.title ?? 'Tool', status: p.status ?? old?.status ?? 'pending',
        // Only explicit, sanitized text output. Never forward opaque/redacted JSON.
        content: p.content ? p.content.filter((c: any) => c.type === 'content' && c.content?.type === 'text' && !c.content.redacted).map((c: any) => ({ type: 'content', content: { type: 'text', text: c.content.text } })) : old?.content };
      tools.set(p.toolCallId, tool);
      rows.set('tool:'+p.toolCallId, {id:'tool:'+p.toolCallId,role:'agent',timestamp:Date.parse(e.at),parts:[{type:'tool_calls',toolCalls:[tool]}]});
    }
    if (e.kind === 'error') rows.set(e.eventId, {id:e.eventId,role:'system',timestamp:Date.parse(e.at),parts:[{type:'content',content:[{type:'text',text:'The agent reported an error. Check its status before retrying.'}]}]});
  }
  return [...rows.values()];
}
