// @ts-check
import { dirname, resolve } from "node:path";
import { cwd } from "node:process";
import * as td from "typedoc-plugin-markdown";

// Extract the package directory name to be used as the part of the markdown links
const dirs = cwd().split("/packages");
const apiDirName = dirs[dirs.length - 1];

/** @param {td.MarkdownApplication} app */
export function load(app) {
  // Set Markdown frontmatter for each page
  app.renderer.on(td.MarkdownPageEvent.BEGIN, (page) => {
    page.frontmatter = {
      title: page.model.name,
    };
  });

  // Rewrite all of the internal links
  // - root relative for compatibility with Next.js
  // - strip the .mdx extension
  app.renderer.on(td.MarkdownPageEvent.END, (page) => {
    if (!page.contents) return;

    page.contents = page.contents.replace(/\(((?:[^\/\)]+\/)*[^\/\)]+)\.mdx\)/gm, (_, path) => {
      const rootRelativeUrl = resolve(`/api${apiDirName}`, dirname(page.url), path);
      return `(${rootRelativeUrl})`;
    });
  });
}
