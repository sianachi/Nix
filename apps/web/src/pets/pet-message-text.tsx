import { nixSchema } from '@nix/editor-schema';
import { markdownToDocument } from '@nix/markdown';
import { Text } from '@nix/ui';
import type { Node as DocumentNode } from '@tiptap/pm/model';
import { Fragment, type ReactElement, type ReactNode } from 'react';
import { Link } from 'react-router';

function workspaceHref(href: string, workspaceId: string): boolean {
  const match = /^\/w\/([a-f0-9-]{36})\/?\?item=[a-f0-9-]{36}$/.exec(href);
  return match?.[1] === workspaceId;
}

function plainText(text: string, workspaceId: string): ReactNode {
  const pattern =
    /\[([^\]\n]{1,240})\]\((\/w\/([a-f0-9-]{36})\/?\?item=([a-f0-9-]{36}))\)|(?<![\w/:])(\/w\/([a-f0-9-]{36})\/?\?item=([a-f0-9-]{36}))/g;
  const parts: ReactNode[] = [];
  let start = 0;
  for (const match of text.matchAll(pattern)) {
    if ((match[3] ?? match[6]) !== workspaceId) continue;
    parts.push(text.slice(start, match.index));
    parts.push(
      <Link key={match.index} to={match[2] ?? match[5] ?? ''} className="underline">
        {match[1] ?? 'Open note'}
      </Link>,
    );
    start = match.index + match[0].length;
  }
  return (
    <>
      {parts}
      {text.slice(start)}
    </>
  );
}

interface MessageHeading {
  readonly sourceLevel: number;
  readonly level: number;
}

/** The conversation owns h2. Each reply starts at h3 and preserves source nesting without skips. */
function messageHeading(value: unknown, outline: MessageHeading[]): 'h3' | 'h4' | 'h5' | 'h6' {
  const sourceLevel =
    typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 6 ? value : 1;
  while (outline.length > 0 && (outline.at(-1)?.sourceLevel ?? 0) >= sourceLevel) outline.pop();
  const level = Math.min(6, (outline.at(-1)?.level ?? 2) + 1);
  outline.push({ sourceLevel, level });
  return (['h3', 'h4', 'h5', 'h6'] as const)[level - 3] ?? 'h3';
}

/** Render a validated document through React; model HTML, images and external URLs stay inert. */
function messageNode(
  node: DocumentNode,
  workspaceId: string,
  outline: MessageHeading[],
): ReactNode {
  const children: ReactNode[] = [];
  node.forEach((child, _offset, index) => {
    children.push(<Fragment key={index}>{messageNode(child, workspaceId, outline)}</Fragment>);
  });
  switch (node.type.name) {
    case 'text': {
      const literal = node.marks.some(
        (mark) => mark.type.name === 'code' || mark.type.name === 'link',
      );
      let content: ReactNode = literal ? node.text : plainText(node.text ?? '', workspaceId);
      for (const mark of node.marks) {
        switch (mark.type.name) {
          case 'bold':
            content = <strong className="font-semibold">{content}</strong>;
            break;
          case 'italic':
            content = <em>{content}</em>;
            break;
          case 'strike':
            content = <s>{content}</s>;
            break;
          case 'code':
            content = <code className="rounded-sm bg-surface px-1 font-mono">{content}</code>;
            break;
          case 'link': {
            const href = typeof mark.attrs.href === 'string' ? mark.attrs.href : '';
            if (workspaceHref(href, workspaceId))
              content = (
                <Link to={href} className="underline">
                  {content}
                </Link>
              );
            break;
          }
        }
      }
      return content;
    }
    case 'paragraph':
      return (
        <Text as="p" className="whitespace-pre-wrap">
          {children}
        </Text>
      );
    case 'heading': {
      const level = messageHeading(node.attrs.level, outline);
      return (
        <Text as={level} variant={level}>
          {children}
        </Text>
      );
    }
    case 'bulletList':
      return <ul className="list-disc space-y-1 pl-5">{children}</ul>;
    case 'orderedList':
      return (
        <ol start={Number(node.attrs.start) || 1} className="list-decimal space-y-1 pl-5">
          {children}
        </ol>
      );
    case 'listItem':
      return <li className="space-y-1">{children}</li>;
    case 'blockquote':
    case 'callout':
      return (
        <blockquote className="space-y-2 border-l-2 border-divider pl-3">{children}</blockquote>
      );
    case 'codeBlock':
      return (
        <pre className="max-w-full overflow-x-auto rounded-sm border border-divider bg-surface p-3">
          <Text as="span" className="font-mono">
            <code>{node.textContent}</code>
          </Text>
        </pre>
      );
    case 'hardBreak':
      return <br />;
    case 'horizontalRule':
      return <hr className="border-divider" />;
    case 'table':
      return (
        <div className="max-w-full overflow-x-auto">
          <table className="w-full border-collapse">
            <tbody>{children}</tbody>
          </table>
        </div>
      );
    case 'tableRow':
      return <tr>{children}</tr>;
    case 'tableHeader':
      return (
        <th scope="col" className="border border-divider bg-surface p-2 text-left font-semibold">
          {children}
        </th>
      );
    case 'tableCell':
      return <td className="border border-divider p-2 align-top">{children}</td>;
    case 'image':
      return (
        <Text as="span">{`![${String(node.attrs.alt ?? '')}](${String(node.attrs.src ?? '')})`}</Text>
      );
    case 'reference':
      return <Text as="span">{String(node.attrs.label ?? '')}</Text>;
    default:
      return <>{children}</>;
  }
}

/** Assistant Markdown is formatting only; only citations in the current workspace navigate. */
export function PetMessageText({
  text,
  workspaceId,
  format = 'markdown',
}: {
  readonly text: string;
  readonly workspaceId: string;
  readonly format?: 'markdown' | 'plain';
}): ReactElement {
  const parsed = format === 'markdown' ? markdownToDocument(text) : undefined;
  if (!parsed?.ok) {
    return (
      <Text className="min-w-0 whitespace-pre-wrap wrap-anywhere">
        {plainText(text, workspaceId)}
      </Text>
    );
  }
  return (
    <div className="flex min-w-0 max-w-full flex-col gap-3 wrap-anywhere">
      {messageNode(nixSchema.nodeFromJSON(parsed.doc), workspaceId, [])}
    </div>
  );
}
