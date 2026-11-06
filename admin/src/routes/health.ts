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

const SITE_DIR = process.env.SITE_DIR || join(process.cwd(), '..', 'site');

const router = Router();

// The former POST /terminal endpoint (arbitrary /bin/sh as the CMS user,
// with every container secret in its environment) was removed 2026-11: one
// stolen session became host root. Use SSH/Tailscale for shell access.

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
