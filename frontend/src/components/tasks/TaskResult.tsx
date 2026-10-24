import React, { useCallback, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { Copy, Check, Download, FileText } from 'lucide-react';
import styles from './TaskResult.module.css';

export interface TaskResultProps {
  /** Raw markdown string returned by the Report Agent */
  markdown: string;
  /** Optional task ID shown in the header / PDF filename */
  taskId?: string;
  /** Optional title override */
  title?: string;
  className?: string;
}

// ─── Sub-components for ReactMarkdown overrides ────────────────────────────

interface CodeProps {
  inline?: boolean;
  className?: string;
  children?: React.ReactNode;
  [key: string]: unknown;
}

function CodeBlock({ inline, className, children }: CodeProps) {
  const [copied, setCopied] = useState(false);
  const match = /language-(\w+)/.exec(className ?? '');
  const language = match?.[1] ?? '';
  const codeString = String(children).replace(/\n$/, '');

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(codeString);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard not available in some environments — fail silently
    }
  };

  if (inline) {
    return (
      <code className={styles.inlineCode} {...(className ? { className } : {})}>
        {children}
      </code>
    );
  }

  return (
    <div className={styles.codeBlock} data-testid="code-block">
      <div className={styles.codeBlockHeader}>
        <span className={styles.codeLanguage}>{language || 'code'}</span>
        <button
          type="button"
          className={styles.copyCodeBtn}
          onClick={handleCopy}
          aria-label="Copy code to clipboard"
        >
          {copied ? (
            <>
              <Check size={13} />
              <span>Copied!</span>
            </>
          ) : (
            <>
              <Copy size={13} />
              <span>Copy</span>
            </>
          )}
        </button>
      </div>
      <SyntaxHighlighter
        language={language || 'text'}
        style={vscDarkPlus}
        customStyle={{ margin: 0, padding: '16px', fontSize: '0.85rem', borderRadius: 0 }}
      >
        {codeString}
      </SyntaxHighlighter>
    </div>
  );
}

// ─── TaskResult component ──────────────────────────────────────────────────

export const TaskResult: React.FC<TaskResultProps> = ({
  markdown,
  taskId,
  title = 'Task Result',
  className,
}) => {
  const [copied, setCopied] = useState(false);
  const [pdfLoading, setPdfLoading] = useState(false);

  // ── Copy full markdown to clipboard ─────────────────────────────────────
  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(markdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // fail silently
    }
  }, [markdown]);

  // ── Download PDF via browser print ──────────────────────────────────────
  const handleDownloadPdf = useCallback(async () => {
    setPdfLoading(true);
    try {
      // Dynamically import jsPDF to keep initial bundle small
      const { default: jsPDF } = await import('jspdf');
      // @ts-expect-error jspdf-autotable attaches itself to the jsPDF prototype
      await import('jspdf-autotable');

      const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

      const pageWidth = doc.internal.pageSize.getWidth();
      const margin = 15;
      const maxLineWidth = pageWidth - margin * 2;
      let y = margin;

      const titleText = title + (taskId ? ` — ${taskId}` : '');
      doc.setFontSize(18);
      doc.setFont('helvetica', 'bold');
      doc.text(titleText, margin, y);
      y += 10;

      doc.setFontSize(9);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(120, 120, 120);
      doc.text(`Generated: ${new Date().toLocaleString()}`, margin, y);
      y += 8;

      doc.setTextColor(0, 0, 0);
      doc.setFontSize(11);

      // Render markdown lines one by one
      const lines = markdown.split('\n');
      for (const rawLine of lines) {
        // Check for page overflow
        if (y > doc.internal.pageSize.getHeight() - margin) {
          doc.addPage();
          y = margin;
        }

        const line = rawLine.trimEnd();

        if (/^#{1,6}\s/.test(line)) {
          // Headings
          const level = (line.match(/^(#+)/)?.[1].length ?? 1);
          const text = line.replace(/^#+\s*/, '');
          const fontSize = Math.max(14 - (level - 1) * 2, 10);
          doc.setFontSize(fontSize);
          doc.setFont('helvetica', 'bold');
          if (y > margin + 10) y += 2;
          const wrapped = doc.splitTextToSize(text, maxLineWidth);
          doc.text(wrapped, margin, y);
          y += wrapped.length * (fontSize * 0.4) + 3;
          doc.setFontSize(11);
          doc.setFont('helvetica', 'normal');
        } else if (line.startsWith('```')) {
          // Skip fence markers
        } else if (/^\s*[-*+]\s/.test(line)) {
          // Bullet list
          const text = line.replace(/^\s*[-*+]\s/, '');
          const stripped = text.replace(/[*_`]/g, '');
          const wrapped = doc.splitTextToSize(`• ${stripped}`, maxLineWidth - 4);
          doc.text(wrapped, margin + 4, y);
          y += wrapped.length * 5;
        } else if (/^\s*\d+\.\s/.test(line)) {
          // Ordered list
          const stripped = line.replace(/[*_`]/g, '');
          const wrapped = doc.splitTextToSize(stripped, maxLineWidth - 4);
          doc.text(wrapped, margin + 4, y);
          y += wrapped.length * 5;
        } else if (line.trim() === '') {
          y += 3;
        } else {
          // Normal paragraph — strip markdown syntax chars
          const stripped = line
            .replace(/\*\*(.+?)\*\*/g, '$1')
            .replace(/\*(.+?)\*/g, '$1')
            .replace(/__(.+?)__/g, '$1')
            .replace(/_(.+?)_/g, '$1')
            .replace(/`(.+?)`/g, '$1')
            .replace(/\[(.+?)\]\(.+?\)/g, '$1');
          const wrapped = doc.splitTextToSize(stripped, maxLineWidth);
          doc.text(wrapped, margin, y);
          y += wrapped.length * 5;
        }
      }

      const filename = `task-result${taskId ? `-${taskId}` : ''}.pdf`;
      doc.save(filename);
    } catch (err) {
      console.error('Failed to generate PDF:', err);
    } finally {
      setPdfLoading(false);
    }
  }, [markdown, taskId, title]);

  return (
    <div className={`${styles.container} ${className ?? ''}`} data-testid="task-result">
      {/* ── Toolbar ── */}
      <div className={styles.toolbar}>
        <div className={styles.toolbarTitle}>
          <FileText size={16} aria-hidden />
          <span>{title}</span>
          {taskId && <span className={styles.taskId}>#{taskId}</span>}
        </div>

        <div className={styles.toolbarActions}>
          <button
            type="button"
            className={styles.actionBtn}
            onClick={handleCopy}
            aria-label="Copy markdown to clipboard"
            data-testid="copy-markdown-btn"
          >
            {copied ? (
              <>
                <Check size={14} />
                <span>Copied!</span>
              </>
            ) : (
              <>
                <Copy size={14} />
                <span>Copy</span>
              </>
            )}
          </button>

          <button
            type="button"
            className={styles.actionBtn}
            onClick={handleDownloadPdf}
            disabled={pdfLoading}
            aria-label="Download result as PDF"
            data-testid="download-pdf-btn"
          >
            <Download size={14} />
            <span>{pdfLoading ? 'Generating…' : 'PDF'}</span>
          </button>
        </div>
      </div>

      {/* ── Markdown body ── */}
      <div className={styles.markdownBody} data-testid="markdown-body">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            // Sanitisation: react-markdown renders to React elements (no
            // dangerouslySetInnerHTML), so arbitrary HTML in the markdown
            // source is never executed. We additionally block raw <script>
            // and <iframe> tags by overriding the `script` and `iframe`
            // component renderers to return null.
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            script: () => null,
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            iframe: () => null,

            code({ inline, className: cls, children: ch, ...rest }: CodeProps) {
              return (
                <CodeBlock
                  inline={inline}
                  className={cls}
                  {...rest}
                >
                  {ch}
                </CodeBlock>
              );
            },

            a({ href, children }) {
              return (
                <a
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={styles.link}
                >
                  {children}
                </a>
              );
            },

            table({ children }) {
              return (
                <div className={styles.tableWrapper} data-testid="markdown-table">
                  <table className={styles.mdTable}>{children}</table>
                </div>
              );
            },

            th({ children }) {
              return <th className={styles.mdTh}>{children}</th>;
            },

            td({ children }) {
              return <td className={styles.mdTd}>{children}</td>;
            },

            tr({ children }) {
              return <tr className={styles.mdTr}>{children}</tr>;
            },
          }}
        >
          {markdown}
        </ReactMarkdown>
      </div>
    </div>
  );
};

export default TaskResult;
