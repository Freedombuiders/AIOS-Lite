import type { MarketTemplate } from './catalog.js';

export interface TemplateFile { path: string; kind: 'persona' | 'knowledge' | 'skill'; description: string; content: string; }
export interface TemplateSkill { id: string; name: string; description: string; instructions: string; }

/** The preview and installer use this same renderer. No mock documentation. */
export function renderMarketFiles(template: MarketTemplate, name = '[Tên agent]', fields: Record<string, string> = {}, sourceText = ''): TemplateFile[] {
  const skills = template.skills ?? [];
  const skillIndex = skills.length ? '\n\n## Quy trình chuyên môn được cài\n' + skills.map(s => `- ${s.name}: đọc skills/${s.id}/SKILL.md — ${s.description}`).join('\n') + '\nCác SKILL.md là hướng dẫn tư vấn. Dùng Read để tra khi cần; không cấp thêm công cụ hay quyền thực hiện hành động.\n' : '';
  const knowledge = template.fields.map(f => `## ${f.label}\n${fields[f.key]?.trim() || f.defaultValue || 'Chưa cung cấp. Không tự suy đoán.'}`);
  if (sourceText) knowledge.push(`## Tài liệu tham khảo do trung tâm cung cấp\n${sourceText}`);
  return [
    { path: 'CLAUDE.md', kind: 'persona', description: 'Vai trò, giọng tư vấn và giới hạn hành vi.', content: `# ${name}\n\n${template.persona}${skillIndex}\n` },
    { path: 'knowledge/customer-care.md', kind: 'knowledge', description: 'Khung hồ sơ trung tâm; được điền từ các bước thiết lập.', content: `# Hồ sơ tư vấn\n\n${knowledge.join('\n\n')}\n` },
    ...skills.map(s => ({ path: `skills/${s.id}/SKILL.md`, kind: 'skill' as const, description: s.description, content: `---\nname: ${s.id}\ndescription: ${s.description}\n---\n\n# ${s.name}\n\n${s.instructions}\n` })),
  ];
}
