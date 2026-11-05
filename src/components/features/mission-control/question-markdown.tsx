import type { AnchorHTMLAttributes } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/utils';

const REMARK_PLUGINS = [remarkGfm];
const COMPONENTS = {
  a: ({ node: _node, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { node?: unknown }) => (
    <a {...props} target="_blank" rel="noopener noreferrer" />
  ),
};

/** A question's context (ADR-0037 §1): CommonMark + GFM, raw HTML dropped, links in a new tab. */
const QuestionMarkdown = ({ text, className }: { text: string; className?: string }) => (
  <div
    className={cn(
      'min-w-0 select-text break-words text-sm leading-6 text-foreground/85',
      '[&_a]:text-ui-blue [&_a]:underline [&_a]:underline-offset-2',
      '[&_p]:my-2 [&_p:first-child]:mt-0 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5',
      '[&_h1]:mt-3 [&_h1]:font-semibold [&_h2]:mt-3 [&_h2]:font-semibold [&_h3]:mt-3 [&_h3]:font-medium',
      '[&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:text-xs [&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-muted [&_pre]:p-2',
      '[&_table]:my-2 [&_table]:block [&_table]:overflow-x-auto [&_th]:border [&_th]:border-foreground/10 [&_th]:px-2 [&_th]:text-left',
      '[&_td]:border [&_td]:border-foreground/10 [&_td]:px-2 [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground',
      className,
    )}
  >
    <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={COMPONENTS} skipHtml>{text}</ReactMarkdown>
  </div>
);

export default QuestionMarkdown;
