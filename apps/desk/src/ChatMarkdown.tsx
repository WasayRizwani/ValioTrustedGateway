import { Fragment, type ReactNode } from "react";

// Minimal, safe markdown renderer for agent replies. Builds React elements
// only (never innerHTML), so raw HTML in the text is shown as literal text.

function inline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\*[^*\s][^*]*\*|(?<![A-Za-z0-9])_[^_\s][^_]*_(?![A-Za-z0-9]))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const key = `${keyPrefix}-${i++}`;
    if (tok.startsWith("**") || tok.startsWith("__")) {
      out.push(<strong key={key}>{inline(tok.slice(2, -2), key)}</strong>);
    } else if (tok.startsWith("`")) {
      out.push(<code key={key}>{tok.slice(1, -1)}</code>);
    } else {
      out.push(<em key={key}>{inline(tok.slice(1, -1), key)}</em>);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

const isTableSep = (l: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l) && l.includes("-");
const isTableRow = (l: string) => l.includes("|");
const ulRe = /^\s*[-*•]\s+(.*)$/;
const olRe = /^\s*\d+[.)]\s+(.*)$/;

export function ChatMarkdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let k = 0;
  let olCounter = 1;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }

    // fenced code
    if (/^\s*```/.test(line)) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      blocks.push(<pre key={k++} className="md-code">{buf.join("\n")}</pre>);
      continue;
    }

    // table
    if (isTableRow(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const head = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map((c) =>
        c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : undefined,
      );
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim() && isTableRow(lines[i])) rows.push(splitRow(lines[i++]));
      const tk = k++;
      blocks.push(
        <div key={tk} className="md-table-wrap">
          <table className="md-table">
            <thead>
              <tr>
                {head.map((h, c) => (
                  <th key={c} style={{ textAlign: aligns[c] }}>{inline(h, `${tk}h${c}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {head.map((_, c) => (
                    <td key={c} style={{ textAlign: aligns[c] }}>{inline(r[c] ?? "", `${tk}r${ri}c${c}`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    // heading
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      olCounter = 1;
      const lvl = Math.min(h[1].length + 2, 6);
      const Tag = `h${lvl}` as "h3";
      blocks.push(<Tag key={k++} className="md-h">{inline(h[2], `h${k}`)}</Tag>);
      i++;
      continue;
    }

    // lists
    const listMatch = ulRe.exec(line) ? ulRe : olRe.exec(line) ? olRe : null;
    if (listMatch) {
      const explicitFirst = listMatch === olRe ? Number(/^\s*(\d+)[.)]/.exec(line)?.[1] ?? 1) : 1;
      const olStart = listMatch === olRe ? (explicitFirst > 1 ? explicitFirst : olCounter) : 1;
      const items: string[] = [];
      while (i < lines.length) {
        if (!lines[i].trim() && i + 1 < lines.length && listMatch.test(lines[i + 1])) {
          i++;
          continue;
        }
        const mm = listMatch.exec(lines[i]);
        if (!mm) break;
        items.push(mm[1]);
        i++;
      }
      if (listMatch === olRe) {
        olCounter = olStart + items.length;
      }
      const lk = k++;
      const kids = items.map((it, ii) => <li key={ii}>{inline(it, `${lk}-${ii}`)}</li>);
      blocks.push(
        listMatch === ulRe ? (
          <ul key={lk}>{kids}</ul>
        ) : (
          <ol key={lk} start={olStart > 1 ? olStart : undefined}>
            {kids}
          </ol>
        ),
      );
      continue;
    }

    // paragraph
    const buf: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^\s*```/.test(lines[i]) &&
      !/^#{1,6}\s/.test(lines[i]) &&
      !ulRe.test(lines[i]) &&
      !olRe.test(lines[i]) &&
      !(isTableRow(lines[i]) && i + 1 < lines.length && isTableSep(lines[i + 1]))
    ) {
      buf.push(lines[i++]);
    }
    const pk = k++;
    blocks.push(
      <p key={pk}>
        {buf.map((l, li) => (
          <Fragment key={li}>
            {li > 0 && <br />}
            {inline(l, `${pk}-${li}`)}
          </Fragment>
        ))}
      </p>,
    );
  }

  return <div className="md">{blocks}</div>;
}
