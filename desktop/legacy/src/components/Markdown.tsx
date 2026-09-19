import { marked } from "marked";
import DOMPurify from "dompurify";
export function Markdown({ text }: { text: string }) {
  return (
    <div
      className="markdown"
      onClick={(event) => {
        const link = (event.target as HTMLElement).closest("a");
        if (!link) return;
        event.preventDefault();
        if (/^https?:\/\//i.test(link.href))
          void window.bubble
            ?.call("openLink", { url: link.href })
            .catch(() => {});
      }}
      dangerouslySetInnerHTML={{
        __html: DOMPurify.sanitize(
          marked.parse(text, { async: false, breaks: true }),
          {
            FORBID_TAGS: ["img", "iframe", "form", "input", "style"],
            FORBID_ATTR: ["style"],
          },
        ),
      }}
    />
  );
}
