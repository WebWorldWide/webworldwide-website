# Ghost to Hugo Migration Tool

This folder contains the official migration script to convert a Ghost blog export into Markdown files optimized for the **Terminal Eighty** Hugo architecture.

## What it does

- Converts Ghost JSON exports to Markdown.
- Automatically downloads all images from your live Ghost site.
- Rewrites image paths in your Markdown files to match Hugo's `static/images` structure.
- Preserves titles, slugs, publish dates, tags, and draft status.
- Converts Ghost "Bookmark Cards" and "Image Cards" into standard Markdown syntax.

## Prerequisites

1. Node.js installed on your machine.
2. A `.json` export file from your Ghost admin panel (`Settings -> Labs -> Export`).

## Usage

1. **Install Dependencies**

   ```bash
   cd migrate
   npm install
   ```

2. **Run the Migration Script**
   Place your Ghost `.json` file in this directory and run:

   ```bash
   node migrate.js --input your-ghost-export.json \
                   --output ../site/content \
                   --images ../site/static/images \
                   --download-images
   ```

   **Flags:**
   - `--input`: Path to your Ghost JSON export.
   - `--output`: Directory where the Markdown files should be generated.
   - `--images`: Directory where downloaded images should be saved.
   - `--download-images`: (Optional) Automatically fetch images from the live URLs found in the JSON file.

3. **Verify**
   Once complete, your posts will be in `../site/content/posts` and your images will be in `../site/static/images`. You can boot your Hugo server to verify the output!
