import { Router } from 'express';
import {
  getSystemStats,
  getTemperature,
  getDiskUsage,
  getDockerStats,
  getBackupStatus,
} from '../utils/system.js';
import { readdirSync } from 'fs';
import { join } from 'path';
import { exec } from 'child_process';
import util from 'util';
const execAsync = util.promisify(exec);

const SITE_DIR = process.env.SITE_DIR || join(process.cwd(), '..', 'site');

const router = Router();

// Allowed commands for the secure terminal (diagnostics only)
const ALLOWED_COMMANDS = [
  'uptime',
  'df',
  'free',
  'top',
  'htop',
  'ps',
  'whoami',
  'hostname',
  'date',
  'uname',
  'cat',
  'ls',
  'pwd',
  'echo',
  'docker',
  'systemctl',
  'journalctl',
  'vcgencmd',
  'ip',
  'ping',
  'dig',
  'curl',
  'git',
  'npm',
  'node',
];

// Secure Terminal Endpoint
router.post('/terminal', async (req, res) => {
  try {
    const { command } = req.body;
    if (!command) return res.status(400).json({ error: 'Command required' });

    // Extract the base command (first word)
    const baseCmd = command.trim().split(/\s+/)[0];

    // Block dangerous operators
    if (/[;&|`$(){}]/.test(command)) {
      return res.json({
        output: '[BLOCKED] Shell operators (;, &, |, `, $) are not allowed for security.',
      });
    }

    if (!ALLOWED_COMMANDS.includes(baseCmd)) {
      return res.json({
        output: `[BLOCKED] Command "${baseCmd}" is not in the allowlist.\nAllowed: ${ALLOWED_COMMANDS.join(', ')}`,
      });
    }

    const { stdout, stderr } = await execAsync(command, { timeout: 15000 });

    res.json({
      output: stdout + (stderr ? '\n[STDERR]:\n' + stderr : ''),
    });
  } catch (err) {
    res.json({
      output: (err.stdout || '') + '\n[ERROR]:\n' + (err.stderr || err.message),
    });
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
    });
  } catch (err) {
    console.error('Health API error:', err);
    res.status(500).json({ error: 'Failed to fetch health stats' });
  }
});

export default router;
