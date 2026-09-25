import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { minify } from "html-minifier-terser";

async function findHtmlFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await findHtmlFiles(path));
    else if (entry.name.endsWith(".html")) files.push(path);
  }
  return files;
}

const files = await findHtmlFiles("dist");
for (const file of files) {
  const html = await readFile(file, "utf8");
  const result = await minify(html, {
    collapseWhitespace: true,
    conservativeCollapse: false,
    removeComments: true,
    removeAttributeQuotes: true,
    removeRedundantAttributes: true,
    useShortDoctype: true,
    minifyCSS: true,
    minifyJS: true
  });
  await writeFile(file, result, "utf8");
  console.log(`HTML minificado: ${file} (${html.length} -> ${result.length} bytes)`);
}
