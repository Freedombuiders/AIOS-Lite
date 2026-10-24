import fs from 'node:fs';
import path from 'node:path';

export const MODULE_ID = /^[a-z][a-z0-9-]{1,30}$/;

const titleCase = (id: string) => id.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

/** Copy modules/_template to modules/<id>, replacing the id, table prefix and agent/skill names. */
export function scaffoldModule(modulesDir: string, id: string): string {
  if (!MODULE_ID.test(id)) throw new Error(`Id module "${id}" không hợp lệ: dùng chữ thường, số, dấu gạch ngang; bắt đầu bằng chữ; 2–31 ký tự.`);
  const from = path.join(modulesDir, '_template');
  const to = path.join(modulesDir, id);
  if (!fs.existsSync(from)) throw new Error(`Không thấy khuôn ${from}.`);
  if (fs.existsSync(to)) throw new Error(`Module "${id}" đã tồn tại tại ${to}.`);
  const prefix = id.replace(/-/g, '_');
  const sub = (s: string) => s.replaceAll('_template', id).replaceAll('template_', `${prefix}_`).replaceAll('template-', `${id}-`);

  const copy = (src: string, dst: string) => {
    fs.mkdirSync(dst, { recursive: true });
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
      const target = path.join(dst, sub(e.name));
      if (e.isDirectory()) copy(path.join(src, e.name), target);
      else fs.writeFileSync(target, sub(fs.readFileSync(path.join(src, e.name), 'utf8')));
    }
  };
  try {
    copy(from, to);
    const manifestFile = path.join(to, 'module.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as Record<string, unknown>;
    manifest.name = titleCase(id);
    manifest.description = `Module ${titleCase(id)} (tạo từ khuôn mẫu). Sửa mô tả này.`;
    fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  } catch (err) {
    fs.rmSync(to, { recursive: true, force: true });
    throw err;
  }
  return to;
}
