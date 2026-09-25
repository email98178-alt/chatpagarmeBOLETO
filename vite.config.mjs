import { defineConfig } from "vite";
import { readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

function findHtmlFiles(directory) {
  const result = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const filePath = join(directory, entry.name);
    if (entry.isDirectory() && !["node_modules", "dist", ".git"].includes(entry.name)) {
      result.push(...findHtmlFiles(filePath));
    } else if (entry.isFile() && entry.name.endsWith(".html")) {
      result.push(filePath);
    }
  }
  return result;
}

const root = resolve(".");
const htmlInputs = Object.fromEntries(
  findHtmlFiles(root).map((filePath) => {
    const key = relative(root, filePath).replace(/\\/g, "/").replace(/\.html$/, "");
    return [key, filePath];
  })
);

export default defineConfig({
  build: {
    sourcemap: false,
    minify: "esbuild",
    rollupOptions: {
      input: htmlInputs,
      output: {
        entryFileNames: "assets/[hash].js",
        chunkFileNames: "assets/[hash].js",
        assetFileNames: "assets/[hash][extname]"
      }
    }
  }
});
