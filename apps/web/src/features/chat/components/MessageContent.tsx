import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import { CodeBlock } from './CodeBlock';

export interface MessageContentProps {
  readonly content: string;
  readonly className?: string;
}

function safeMarkdownUrl(value: string): string | undefined {
  const url = value.trim();
  if (url.length === 0 || /[\u0000-\u001f\u007f]/u.test(url)) return undefined;
  try {
    const parsed = new URL(url, 'https://cheapai.invalid');
    return ['http:', 'https:', 'mailto:'].includes(parsed.protocol) ? url : undefined;
  } catch {
    return undefined;
  }
}

const components: Components = {
  a({ href, title, children }) {
    const safeHref = href ? safeMarkdownUrl(href) : undefined;
    if (!safeHref) return <span>{children}</span>;
    const destination = new URL(safeHref, 'https://cheapai.invalid');
    const external =
      destination.origin !== 'https://cheapai.invalid' &&
      (destination.protocol === 'http:' || destination.protocol === 'https:');
    return (
      <a
        className="break-words text-[var(--color-primary)] underline underline-offset-2 hover:opacity-80"
        href={safeHref}
        rel={external ? 'noopener noreferrer' : undefined}
        target={external ? '_blank' : undefined}
        title={title}
      >
        {children}
      </a>
    );
  },
  code({ className, children }) {
    return <CodeBlock className={className}>{children}</CodeBlock>;
  },
  pre({ children }) {
    return <>{children}</>;
  },
  table({ children }) {
    return (
      <div className="my-4 max-w-full overflow-x-auto">
        <table className="min-w-full border-collapse text-left text-sm">{children}</table>
      </div>
    );
  },
  th({ children }) {
    return (
      <th className="border border-[var(--color-line)] bg-[var(--color-surface-subtle)] px-3 py-2 font-semibold">
        {children}
      </th>
    );
  },
  td({ children }) {
    return <td className="border border-[var(--color-line)] px-3 py-2 align-top">{children}</td>;
  },
};

/** Safe Markdown and GFM renderer. Raw HTML stays disabled and unsafe URLs are discarded. */
export function MessageContent({ content, className }: MessageContentProps) {
  return (
    <div
      className={`chat-message-content break-words text-sm leading-7 text-[var(--color-foreground)] [&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:border-[var(--color-line-strong)] [&_blockquote]:pl-4 [&_h1]:my-4 [&_h1]:text-xl [&_h1]:font-semibold [&_h2]:my-3 [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:my-3 [&_h3]:font-semibold [&_li]:whitespace-pre-wrap [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-6 [&_p]:my-3 [&_p]:whitespace-pre-wrap [&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-6 ${className ?? ''}`}
    >
      <ReactMarkdown
        components={components}
        rehypePlugins={[rehypeSanitize]}
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={safeMarkdownUrl}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
