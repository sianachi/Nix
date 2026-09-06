import { Text } from '@nix/ui';
import { Fragment, type ReactElement } from 'react';
import { Link } from 'react-router';

/** Render only workspace item links; arbitrary model HTML and URLs remain inert text. */
export function PetMessageText({
  text,
  workspaceId,
}: {
  readonly text: string;
  readonly workspaceId: string;
}): ReactElement {
  const pattern =
    /\[([^\]\n]{1,240})\]\((\/w\/([a-f0-9-]{36})\/?\?item=([a-f0-9-]{36}))\)|(?<![\w/:])(\/w\/([a-f0-9-]{36})\/?\?item=([a-f0-9-]{36}))/g;
  const parts: ReactElement[] = [];
  let start = 0;
  for (const match of text.matchAll(pattern)) {
    if ((match[3] ?? match[6]) !== workspaceId) continue;
    parts.push(
      <Fragment key={`${String(match.index)}:text`}>{text.slice(start, match.index)}</Fragment>,
    );
    parts.push(
      <Link
        key={`${String(match.index)}:link`}
        to={match[2] ?? match[5] ?? ''}
        className="underline"
      >
        {match[1] ?? 'Open note'}
      </Link>,
    );
    start = match.index + match[0].length;
  }
  return (
    <Text className="whitespace-pre-wrap break-words">
      {parts}
      {text.slice(start)}
    </Text>
  );
}
