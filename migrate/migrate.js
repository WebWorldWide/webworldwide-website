#!/usr/bin/env node

/**
 * Ghost → Hugo Migration Script
 *
 * Converts a Ghost JSON export into Hugo-compatible markdown files.
 *
 * Usage:
 *   node migrate.js --input ghost-export.json --output ../site/content --images ../site/static/images
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { execSync } from 'child_process';
import TurndownService from 'turndown';

// Parse CLI args
const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 ? args[idx + 1] : null;
}

const inputFile = getArg('input');
const outputDir = getArg('output') || '../site/content';
const imagesDir = getArg('images') || '../site/static/images';
const downloadImages = args.includes('--download-images');

if (!inputFile) {
  console.error(
    'Usage: node migrate.js --input ghost-export.json [--output ../site/content] [--images ../site/static/images] [--download-images]',
  );
  process.exit(1);
}

// Setup Turndown (HTML → Markdown)
const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
  emDelimiter: '*',
});

// Custom rule: Ghost bookmark cards
turndown.addRule('ghostBookmark', {
  filter: (node) => node.classList && node.classList.contains('kg-bookmark-card'),
  replacement: (content, node) => {
    const link = node.querySelector('.kg-bookmark-container');
    const title = node.querySelector('.kg-bookmark-title');
    const desc = node.querySelector('.kg-bookmark-description');
    if (link && title) {
      const url = link.getAttribute('href') || '';
      const titleText = title.textContent || '';
      const descText = desc ? desc.textContent : '';
      return `\n[**${titleText}**](${url})${descText ? ` — ${descText}` : ''}\n`;
    }
    return content;
  },
});

// Custom rule: Ghost image cards
turndown.addRule('ghostImage', {
  filter: (node) => node.classList && node.classList.contains('kg-image-card'),
  replacement: (content, node) => {
    const img = node.querySelector('img');
    const caption = node.querySelector('figcaption');
    if (img) {
      const src = rewriteImagePath(img.getAttribute('src') || '');
      const alt = img.getAttribute('alt') || caption?.textContent || '';
      return `\n![${alt}](${src})\n`;
    }
    return content;
  },
});

function rewriteImagePath(src) {
  if (!src) return src;
  // Rewrite Ghost image paths
  return src
    .replace(/__GHOST_URL__\/content\/images\//g, '/images/')
    .replace(/https?:\/\/[^/]+\/content\/images\//g, '/images/');
}

// Read Ghost export
console.log(`📖 Reading ${inputFile}...`);
const raw = readFileSync(inputFile, 'utf-8');
const data = JSON.parse(raw);

const db = data.db ? data.db[0].data : data;
const posts = db.posts || [];
const tags = db.tags || [];
const postsTags = db.posts_tags || [];

// Build tag lookup
const tagMap = {};
tags.forEach((t) => {
  tagMap[t.id] = t.slug || t.name;
});

// Build post → tags mapping
const postTagMap = {};
postsTags.forEach((pt) => {
  if (!postTagMap[pt.post_id]) postTagMap[pt.post_id] = [];
  const tagName = tagMap[pt.tag_id];
  if (tagName) postTagMap[pt.post_id].push(tagName);
});

// Ensure output dirs exist
mkdirSync(join(outputDir, 'posts'), { recursive: true });
mkdirSync(imagesDir, { recursive: true });

let converted = 0;
let pages = 0;
const imageUrls = new Set();

for (const post of posts) {
  const title = post.title || 'Untitled';
  const slug = post.slug || title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const date = post.published_at || post.created_at || new Date().toISOString();
  const isDraft = post.status !== 'published';
  const postTags = postTagMap[post.id] || [];
  const isPage = post.type === 'page' || post.page === true || post.page === 1;

  // Convert HTML to Markdown
  let content = '';
  if (post.html) {
    content = turndown.turndown(post.html);
  } else if (post.mobiledoc) {
    // Basic mobiledoc text extraction
    try {
      const md = JSON.parse(post.mobiledoc);
      if (md.cards) {
        md.cards.forEach((card) => {
          if (card[0] === 'markdown' && card[1]?.markdown) {
            content += card[1].markdown + '\n\n';
          } else if (card[0] === 'html' && card[1]?.html) {
            content += turndown.turndown(card[1].html) + '\n\n';
          }
        });
      }
      if (md.sections) {
        md.sections.forEach((section) => {
          if (section[0] === 1 && section[2]) {
            // Text section with markers
            let text = '';
            section[2].forEach((marker) => {
              text += marker[3] || '';
            });
            if (text) content += text + '\n\n';
          }
        });
      }
    } catch (_e) {
      console.warn(`  ⚠️  Could not parse mobiledoc for "${title}"`);
    }
  }

  // Rewrite image paths in content
  content = content
    .replace(/__GHOST_URL__\/content\/images\//g, '/images/')
    .replace(/https?:\/\/[^/]+\/content\/images\//g, '/images/');

  // Collect image URLs for download
  const imgRegex = /!\[.*?\]\((\/images\/[^)]+)\)/g;
  let match;
  while ((match = imgRegex.exec(content)) !== null) {
    imageUrls.add(match[1]);
  }

  // Build frontmatter
  const description = post.custom_excerpt || post.meta_description || '';
  const frontmatter = [
    '---',
    `title: ${JSON.stringify(title)}`,
    `date: ${date}`,
    `slug: "${slug}"`,
    `draft: ${isDraft}`,
    `tags: [${postTags.map((t) => `"${t}"`).join(', ')}]`,
  ];
  if (description) frontmatter.push(`description: ${JSON.stringify(description)}`);
  if (isPage) frontmatter.push(`type: "page"`);
  frontmatter.push('---');
  frontmatter.push('');

  const fileContent = frontmatter.join('\n') + content;

  // Write file
  const dir = isPage ? outputDir : join(outputDir, 'posts');
  const filepath = join(dir, `${slug}.md`);
  writeFileSync(filepath, fileContent);

  if (isPage) {
    pages++;
    console.log(`  📄 Page: ${title} → ${slug}.md`);
  } else {
    converted++;
    console.log(`  📝 Post: ${title} → posts/${slug}.md${isDraft ? ' (draft)' : ''}`);
  }
}

console.log('');
console.log(`✅ Migration complete!`);
console.log(`   ${converted} posts converted`);
console.log(`   ${pages} pages converted`);
console.log(`   ${imageUrls.size} unique image references found`);
console.log('');

if (imageUrls.size > 0) {
  if (downloadImages) {
    console.log('📸 Downloading images...');
    imageUrls.forEach((url) => {
      const targetPath = `${imagesDir}${url.replace('/images/', '/')}`;
      mkdirSync(dirname(targetPath), { recursive: true });
      console.log(`   Downloading ${url}...`);
      try {
        execSync(`curl -s -o "${targetPath}" "https://terminaleighty.com/content${url}"`);
      } catch (_e) {
        console.error(`   ❌ Failed to download ${url}`);
      }
    });
    console.log('✅ Images downloaded successfully!');
  } else {
    console.log('📸 Image download needed!');
    console.log('   Your Ghost posts reference images that need to be downloaded.');
    console.log('   You can download them from your Ghost admin:');
    console.log('   Settings → Labs → Export → Download the /content/images/ folder');
    console.log('   Then place them in: ' + imagesDir);
    console.log('');
    console.log(
      '   Or run migrate.js with the --download-images flag to download them automatically.',
    );
    console.log('');
    console.log('   Or download them manually using these commands:');
    imageUrls.forEach((url) => {
      console.log(
        `   curl --create-dirs -o ${imagesDir}${url.replace('/images/', '/')} https://terminaleighty.com/content${url}`,
      );
    });
  }
}
