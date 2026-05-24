// SPDX-License-Identifier: GPL-3.0-or-later
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { openExternal } from "../lib/external";

// PR/issue bodies are untrusted markdown that often embeds raw HTML (Dependabot's
// <details> release notes, tables, links). rehype-raw parses that HTML, then
// rehype-sanitize strips anything dangerous (scripts, event handlers,
// javascript: URLs) — so we render rich content without an XSS foothold. The CSP
// is still the primary defence; this is the content-level guard on top.
const schema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), "details", "summary"],
};

export function Markdown({ children }: { children: string }) {
  return (
    <div className="md selectable">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw, [rehypeSanitize, schema]]}
        components={{
          // Links open in the real browser, never navigate the app webview.
          a({ href, children }) {
            return (
              <a
                href={href}
                onClick={(e) => {
                  e.preventDefault();
                  if (href) openExternal(href).catch(() => {});
                }}
              >
                {children}
              </a>
            );
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
