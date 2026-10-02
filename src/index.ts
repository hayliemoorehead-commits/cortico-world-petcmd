/**
 * petcmd:桌宠指令。扫描开始菜单的 .lnk 快捷方式,得到"这台机器装了什么"的清单;
 * bot 用 petcmd_launch 按名字启动一个。启动走系统 shell(start),回执只陈述事实:
 * 启动了什么、多久内进程没有立即退出。清单缓存 5 分钟。
 */
import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger, ToolDef, ToolOutcome, World, WorldHost } from 'cortico/core/types.ts';
import type { WorldContext, WorldDefinition } from 'cortico/world.ts';

export interface PetcmdConfig {
  enabled: boolean;
}

export const PETCMD_DEFAULTS: PetcmdConfig = { enabled: true };

/** 开始菜单的两个根:全体用户与当前用户。 */
function startMenuDirs(): string[] {
  const pd = process.env['ProgramData'] ?? 'C:\\ProgramData';
  const ad = process.env['APPDATA'] ?? join(process.env['USERPROFILE'] ?? '', 'AppData', 'Roaming');
  return [join(pd, 'Microsoft', 'Windows', 'Start Menu'), join(ad, 'Microsoft', 'Windows', 'Start Menu')];
}

async function scanDir(dir: string, out: string[], depth = 0): Promise<void> {
  if (depth > 4) return;
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) await scanDir(full, out, depth + 1);
    else if (/\.lnk$/i.test(e.name)) out.push(e.name.replace(/\.lnk$/i, ''));
  }
}

export class PetcmdWorld implements World {
  readonly id = 'petcmd';
  private log: Logger | null = null;
  private cache: string[] | null = null;
  private cacheAt = 0;
  private scanning: Promise<string[]> | null = null;

  constructor() {}

  async start(host: WorldHost): Promise<void> {
    this.log = host.log;
  }

  async stop(): Promise<void> {}

  /** 扫描(带 5 分钟缓存);并发调用共享同一次扫描。 */
  private async apps(): Promise<string[]> {
    const now = Date.now();
    if (this.cache && now - this.cacheAt < 5 * 60_000) return this.cache;
    if (this.scanning) return this.scanning;
    const run = (async () => {
      const out: string[] = [];
      for (const dir of startMenuDirs()) await scanDir(dir, out);
      const list = [...new Set(out)].sort((a, b) => a.localeCompare(b, 'zh'));
      this.cache = list;
      this.cacheAt = Date.now();
      return list;
    })();
    this.scanning = run;
    try {
      return await run;
    } finally {
      if (this.scanning === run) this.scanning = null;
    }
  }

  tools(): ToolDef[] {
    return [
      {
        name: 'petcmd_apps',
        tags: ['read'],
        description: '列出这台电脑开始菜单里的已安装应用(按名排序)。想帮用户打开什么,先用这个看有哪些。',
        parameters: { type: 'object', properties: {}, required: [] },
        handler: async () => {
          const list = await this.apps();
          return { text: `[petcmd_apps] 共 ${list.length} 个:${list.slice(0, 40).join('、')}${list.length > 40 ? ` …等 ${list.length} 个` : ''}` };
        },
      },
      {
        name: 'petcmd_launch',
        tags: ['act'],
        description: '按名字启动一个应用(与 petcmd_apps 里的名字匹配,大小写不敏感、包含即中)。启动经系统 shell;回执陈述启动了什么与结果。',
        parameters: {
          type: 'object',
          properties: { app: { type: 'string', description: '应用名(与 petcmd_apps 一致)或完整的 .lnk 路径。' } },
          required: ['app'],
        },
        handler: async (args) => this.launch(args),
      },
    ];
  }

  private async launch(args: Record<string, unknown>): Promise<ToolOutcome> {
    const want = typeof args.app === 'string' ? args.app.trim() : '';
    if (!want) return { text: '[petcmd_launch 没执行] 缺 app。', failed: true };
    // 目标解析:完整的 .lnk 路径直接用;否则在清单里找包含匹配项
    let target = want;
    if (!/\.lnk$/i.test(want)) {
      const list = await this.apps();
      const hit = list.find((n) => n.toLowerCase() === want.toLowerCase())
        ?? list.find((n) => n.toLowerCase().includes(want.toLowerCase()));
      if (!hit) return { text: `[petcmd_launch 没执行] 开始菜单里没有匹配「${want}」的应用。用 petcmd_apps 看一眼。`, failed: true };
      target = hit;
    }
    // 从缓存名回到真实 .lnk 路径:重新扫一遍拿全路径
    const lnk = await this.findLnkPath(target);
    if (!lnk) return { text: `[petcmd_launch 没执行] 「${target}」的快捷方式文件找不到了(菜单可能刚变)。`, failed: true };
    const ok = await new Promise<boolean>((resolve) => {
      const child = spawn('cmd.exe', ['/c', 'start', '', lnk], { windowsHide: true, stdio: 'ignore', detached: true });
      child.once('error', () => resolve(false));
      child.once('spawn', () => resolve(true));
      setTimeout(() => resolve(true), 3000);
    });
    return ok
      ? { text: `[petcmd_launch] 已启动「${target}」。` }
      : { text: `[petcmd_launch 没执行] 系统 shell 拒绝启动「${target}」。`, failed: true };
  }

  private async findLnkPath(name: string): Promise<string | null> {
    const want = name.toLowerCase().endsWith('.lnk') ? name.toLowerCase() : `${name.toLowerCase()}.lnk`;
    const walk = async (dir: string, depth = 0): Promise<string | null> => {
      if (depth > 4) return null;
      let entries;
      try { entries = await readdir(dir, { withFileTypes: true }); } catch { return null; }
      for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isDirectory()) {
          const r = await walk(full, depth + 1);
          if (r) return r;
        } else if (e.name.toLowerCase() === want) return full;
      }
      return null;
    };
    for (const dir of startMenuDirs()) {
      const r = await walk(dir);
      if (r) return r;
    }
    return null;
  }

  envPromptVars(): Record<string, string> | null {
    return { 'petcmd.note': '你可以列出并启动这台电脑上安装的应用(petcmd_apps / petcmd_launch)。启动是明面动作,做了就会说。' };
  }

  console() {
    return {
      label: '桌宠指令',
      lamps: [{ label: '应用清单', state: this.cache ? 'online' : 'offline', hint: this.cache ? `${this.cache.length} 个应用` : '尚未扫描' }],
      promptDocs: [{
        key: 'worlds.petcmd.envPrompt', title: '桌宠指令', description: '启动应用的工具与边界。',
        path: fileURLToPath(new URL('../ENV_PROMPT.md', import.meta.url)), role: 'envPrompt' as const,
        vars: [{ name: 'petcmd.note', description: '应用启动说明' }],
      }],
    };
  }
}

export function petcmdDefinition(): WorldDefinition<PetcmdConfig> {
  return {
    id: 'petcmd',
    label: '桌宠指令',
    defaults: () => structuredClone(PETCMD_DEFAULTS),
    create: (_ctx: WorldContext<PetcmdConfig>) => new PetcmdWorld(),
  };
}

export default petcmdDefinition();
