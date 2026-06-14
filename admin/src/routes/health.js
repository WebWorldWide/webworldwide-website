import { Router } from 'express';
import {
  getSystemStats,
  getTemperature,
  getDiskUsage,
  getDockerStats,
  getBackupStatus,
  getSystemHealth,
} from '../utils/system.js';
import { readdirSync } from 'fs';
import { join } from 'path';
import { exec } from 'child_process';
import util from 'util';
const execAsync = util.promisify(exec);

const SITE_DIR = process.env.SITE_DIR || join(process.cwd(), '..', 'site');

const router = Router();

// Terminal endpoint — full shell access for the authenticated admin.
// Runs through `/bin/sh -c` (child_process.exec's default) so pipes,
// redirects, env vars and operators all work. This is an admin-only,
// auth-gated surface on the operator's own box, so it intentionally does
// NOT restrict which commands may run. It's bounded only by a timeout and
// an output cap so a runaway command can't hang the box or exhaust memory.
router.post('/terminal', async (req, res) => {
  try {
    const { command } = req.body;
    if (!command || typeof command !== 'string') {
      return res.status(400).json({ error: 'Command required' });
    }
    const { stdout, stderr } = await execAsync(command, {
      timeout: 60000,
      maxBuffer: 8 * 1024 * 1024,
    });
    res.json({ output: stdout + (stderr ? '\n[stderr]\n' + stderr : '') });
  } catch (err) {
    // Non-zero exit, timeout, or spawn error — surface whatever we got so
    // the operator can see the real failure rather than a generic message.
    const parts = [];
    if (err.stdout) parts.push(err.stdout);
    if (err.stderr) parts.push('[stderr]\n' + err.stderr);
    if (err.killed) parts.push('[timed out after 60s]');
    else if (typeof err.code === 'number') parts.push('[exit ' + err.code + ']');
    if (!parts.length) parts.push('[error] ' + err.message);
    res.json({ output: parts.join('\n') });
  }
});

// Central health endpoint that gathers all data
router.get('/', async (req, res) => {
  try {
    const [temp, disk, docker, backup] = await Promise.all([
      getTemperature(),
      getDiskUsage(),
      getDockerStats(),
      getBackupStatus(),
    ]);

    const system = getSystemStats();
    const health = getSystemHealth();

    // Basic blog stats
    const blogStats = { posts: 0, drafts: 0 };
    try {
      const postsDir = join(SITE_DIR, 'content', 'posts');
      const files = readdirSync(postsDir).filter((f) => f.endsWith('.md'));
      blogStats.posts = files.length;
      // Not parsing all frontmatter here for speed, just total count
    } catch (_e) {
      /* posts dir missing — fine, leave count at 0 */
    }

    res.json({
      system,
      temperature: temp,
      disk,
      docker,
      backup,
      blog: blogStats,
      storage: health.storage || { status: health.status || 'unknown' },
      power: health.power || { status: health.status || 'unknown' },
      swap: health.swap || null,
      health_status: health.status || 'unknown',
      health_collected: health.collected_iso || null,
    });
  } catch (err) {
    console.error('Health API error:', err);
    res.status(500).json({ error: 'Failed to fetch health stats' });
  }
});

export default router;
