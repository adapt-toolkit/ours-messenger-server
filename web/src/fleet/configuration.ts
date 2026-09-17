import presets from './config-data/presets.json';
import catalog from './config-data/brain-catalog.json';
export { catalog };
export function effortChoices(harness?: string, model?: string | null): string[] {
  return catalog.models.find(m => m.harness === harness && m.model === model)?.efforts ?? [...new Set(catalog.models.filter(m => m.harness === harness).flatMap(m => m.efforts))];
}
export type ConfigKind = 'role' | 'brain' | 'template' | 'tasks';
export interface Definition {
  mission?: string; persona?: string; bio?: string; briefing_file?: string;
  harness?: string; session?: string; model?: string | null; effort?: string;
  max_tokens?: number; autocompact_pct?: number; model_chain?: string[];
  harness_options?: Record<string, unknown>; session_options?: Record<string, unknown>;
  role?: { ref?: string; inline?: Record<string, unknown> }; brain?: { ref?: string };
  cwd?: string; coordinator?: string; permissions?: { approval?: string; filesystem?: string; unattended?: string };
  version?: number; description?: string; contract?: string;
  room?: { quiet_membership?: boolean; anonymous?: boolean };
  members?: { slot: string; role: string; count: number; agent_template: string }[];
}
export type Configuration = Record<ConfigKind, Record<string, Definition>>;
export const initialConfiguration = (): Configuration => structuredClone(presets) as Configuration;
export function validateDefinition(kind: string, value: Definition, all: Configuration): string {
  if(kind === 'role' && value.mission !== undefined && !value.mission.trim()) return 'Mission must not be blank.';
  if(kind === 'brain') {
    if(!['codex','claude-code'].includes(value.harness ?? '')) return 'Choose a supported harness.';
    if(value.session && !(value.harness === 'codex' ? ['acp','codex-app-server'] : ['acp']).includes(value.session)) return 'Choose a session supported by this harness.';
    if(value.model !== null && value.model !== undefined && !value.model.trim()) return 'Enter a custom model ID.';
    if(value.effort && !effortChoices(value.harness, value.model).includes(value.effort)) return 'Choose an effort supported by this model.';
    if(value.max_tokens !== undefined && (!Number.isInteger(value.max_tokens) || value.max_tokens <= 0)) return 'Max tokens must be a positive integer.';
    if(value.autocompact_pct !== undefined && (value.autocompact_pct < 1 || value.autocompact_pct > 100)) return 'Autocompact must be between 1 and 100.';
  }
  if(kind === 'template') {
    if(value.permissions?.approval !== undefined && !['ask','auto','allow','deny'].includes(value.permissions.approval)) return 'Choose a valid approval policy.';
    if(value.permissions?.filesystem !== undefined && !['read-only','workspace','unrestricted'].includes(value.permissions.filesystem)) return 'Choose a valid filesystem policy.';
    if(value.permissions?.unattended !== undefined && !['deny','wait'].includes(value.permissions.unattended)) return 'Choose a valid unattended policy.';
    if(!value.role?.ref || !Object.hasOwn(all.role,value.role.ref)) return 'Choose an existing role.';
    if(!value.brain?.ref || !Object.hasOwn(all.brain,value.brain.ref)) return 'Choose an existing brain.';
  }
  if(kind === 'tasks') {
    if(!Number.isInteger(value.version) || value.version! < 1) return 'Version must be a positive integer.';
    if(!value.members?.length) return 'Add at least one member.';
    if(value.members.some(m => !Object.hasOwn(all.template,m.agent_template))) return 'Choose an existing agent template for each member.';
    if(value.members.some(m => !m.slot.trim() || !m.role.trim() || !Number.isInteger(m.count) || m.count < 1)) return 'Each member needs a slot, room role and positive count.';
    if(new Set(value.members.map(m => m.slot)).size !== value.members.length) return 'Member slots must be unique.';
  }
  return '';
}
