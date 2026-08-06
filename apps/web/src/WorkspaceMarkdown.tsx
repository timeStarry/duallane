import { Children, Fragment, isValidElement, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { renderMessageParts } from "./emotes";

const disallowedElements = ["img", "table", "thead", "tbody", "tr", "th", "td"];

function renderMarkdownChildren(children: ReactNode): ReactNode {
  return Children.map(children, (child, index) => {
    if (typeof child === "string") {
      return <Fragment key={index}>{renderMessageParts(child)}</Fragment>;
    }
    if (isValidElement<{ children?: ReactNode }>(child) && child.props.children) {
      return child;
    }
    return child;
  });
}

function safeLinkUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? value : "";
  } catch {
    return "";
  }
}

export function WorkspaceMarkdown({ children }: { children: string }) {
  return (
    <div className="workspace-markdown">
      <ReactMarkdown
      disallowedElements={disallowedElements}
      remarkPlugins={[remarkGfm]}
      skipHtml
      unwrapDisallowed={false}
      urlTransform={safeLinkUrl}
      components={{
        a: ({ children: label, href }) => (
          <a href={href} rel="noopener noreferrer" target="_blank">
            {renderMarkdownChildren(label)}
          </a>
        ),
        blockquote: ({ children: content }) => <blockquote>{renderMarkdownChildren(content)}</blockquote>,
        code: ({ children: content, className }) => <code className={className}>{content}</code>,
        del: ({ children: content }) => <del>{renderMarkdownChildren(content)}</del>,
        em: ({ children: content }) => <em>{renderMarkdownChildren(content)}</em>,
        h1: ({ children: content }) => <h3>{renderMarkdownChildren(content)}</h3>,
        h2: ({ children: content }) => <h3>{renderMarkdownChildren(content)}</h3>,
        h3: ({ children: content }) => <h3>{renderMarkdownChildren(content)}</h3>,
        h4: ({ children: content }) => <h4>{renderMarkdownChildren(content)}</h4>,
        h5: ({ children: content }) => <h4>{renderMarkdownChildren(content)}</h4>,
        h6: ({ children: content }) => <h4>{renderMarkdownChildren(content)}</h4>,
        hr: () => <hr className="workspace-markdown-divider" />,
        li: ({ children: content }) => <li>{renderMarkdownChildren(content)}</li>,
        ol: ({ children: content }) => <ol>{renderMarkdownChildren(content)}</ol>,
        p: ({ children: content }) => <p>{renderMarkdownChildren(content)}</p>,
        pre: ({ children: content }) => <pre>{content}</pre>,
        strong: ({ children: content }) => <strong>{renderMarkdownChildren(content)}</strong>,
        ul: ({ children: content }) => <ul>{renderMarkdownChildren(content)}</ul>
      }}
    >
      {children}
      </ReactMarkdown>
    </div>
  );
}
