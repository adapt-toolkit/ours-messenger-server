import type { Message, ToolCallState } from '@acp-components/core';
export function acpMessages(events: any[]): Message[] {
  const rows = new Map<string, Message>();
  const tools = new Map<string, ToolCallState>();
  const toolPayloads = new Map<string, any>();
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
    if (e.kind === 'tool.upsert' || e.kind === 'tool.content_chunk') {
      const old = tools.get(p.toolCallId);
      const prior=toolPayloads.get(p.toolCallId);
      const full={...prior,...p};
      if(e.kind==='tool.content_chunk')full.content=[...(prior?.content ?? []),...(Array.isArray(p.content)?p.content:p.content?[{type:'content',content:p.content}]:[])];
      toolPayloads.set(p.toolCallId,full);
      const content:any[]=(full.content ?? []).filter((c:any)=>c.type==='content'&&c.content?.type==='text'&&!c.content.redacted).map((c:any)=>({type:'content',content:{type:'text',text:c.content.text}}));
      for(const c of full.content ?? []){if(c.type==='diff'&&!c.newText?.redacted&&!c.oldText?.redacted)content.push({type:'diff',path:c.path ?? '',oldText:c.oldText?.text ?? '',newText:c.newText?.text ?? ''});if(c.type==='terminal')content.push({type:'content',content:{type:'text',text:'Terminal '+c.terminalId+' · No terminal output was included in this event.'}});}
      for(const [label,value] of [['Input',full.rawInput],['Output',full.rawOutput]] as const) {
        if(value?.truncated)content.push({type:'content',content:{type:'text',text:label+' exceeded the server size limit; details were omitted.'}});
        if(value?.redacted)content.push({type:'content',content:{type:'text',text:label+' contains protected data and was withheld by the server.'}});
        if(value && !value.redacted && value.json!==undefined) content.push({type:'content',content:{type:'text',text:label+'\n```json\n'+JSON.stringify(value.json,null,2)+'\n```'}});
      }
      // The complete command/title remains inspectable even when the server has no output.
      if(!content.length) content.push({type:'content',content:{type:'text',text:(full.title ?? 'Tool')+'\n\n'+(full.rawInput?.redacted||full.rawOutput?.redacted?'Details were withheld by the server.':(['pending','in_progress','inProgress'].includes(full.status)?'Tool is still running; output has not arrived.':'No additional output was supplied for this tool call.'))}});
      const tool:ToolCallState={...old,toolCallId:p.toolCallId,title:full.title ?? 'Tool',status:full.status ?? 'pending',content};
      tools.set(p.toolCallId, tool);
      rows.set('tool:'+p.toolCallId, {id:'tool:'+p.toolCallId,role:'agent',timestamp:Date.parse(e.at),parts:[{type:'tool_calls',toolCalls:[tool]}]});
    }
    if (e.kind === 'error') rows.set(e.eventId, {id:e.eventId,role:'system',timestamp:Date.parse(e.at),parts:[{type:'content',content:[{type:'text',text:'The agent reported an error. Check its status before retrying.'}]}]});
  }
  return [...rows.values()];
}
