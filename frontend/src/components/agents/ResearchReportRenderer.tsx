import React, { useContext } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneLight, vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { ResearchReportResult } from '../../types/agent';
import { getMarkdown } from '../../utils/agentUtils';
import ThemeContext from '../../context/ThemeContext';
import CopyButton from '../common/CopyButton';
import CollapsibleSection from '../common/CollapsibleSection';
import { useLightbox } from '../../hooks/useLightbox';
import type { LightboxImage } from '../../hooks/useLightbox';
import { ImageLightbox } from '../common/ImageLightbox';
import '../../styles/report.css';

interface Props {
  result: ResearchReportResult | null | undefined;
  searchQuery?: string;
}

const ResearchReportRenderer: React.FC<Props> = ({ result, searchQuery }) => {
  const { t } = useTranslation();
  const { effectiveTheme } = useContext(ThemeContext);
  const markdown = getMarkdown(result);

  if (!markdown) {
    return (
      <div
        className="empty-state"
        id="empty-research"
        style={{
          padding: '24px',
          textAlign: 'center',
          color: 'var(--text-secondary)',
          background: 'var(--white-alpha-02)',
          borderRadius: '8px',
          border: '1px dashed var(--white-alpha-10)',
        }}
      >
        {t('agent.research.empty')}
      </div>
    );
  }

  // Filter check
  const matchesSearch =
    !searchQuery || markdown.toLowerCase().includes(searchQuery.toLowerCase());

  if (!matchesSearch) {
    return (
      <div
        style={{
          padding: '20px',
          textAlign: 'center',
          color: 'var(--text-secondary)',
          fontSize: '0.85rem',
          fontStyle: 'italic',
        }}
      >
        No report content matching search filter "{searchQuery}".
      </div>
    );
  }

  const isLongReport = markdown.length > 500;

  const content = (
    <div
      className="markdown-body"
      id="research-markdown"
      data-testid="research-markdown"
      style={{
        color: 'var(--text-primary)',
        lineHeight: '1.7',
        fontSize: '1rem',
      }}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ inline, className, children, ...props }: any) {
            const match = /language-(\w+)/.exec(className || '');
            const codeString = String(children).replace(/\n$/, '');
            if (!inline && match) {
              return (
                <div
                  style={{
                    position: 'relative',
                    margin: '16px 0',
                    borderRadius: '8px',
                    overflow: 'hidden',
                    border: '1px solid var(--border-muted)',
                    backgroundColor: 'var(--surface-primary)',
                  }}
                  data-testid="code-block"
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      padding: '6px 12px',
                      background: 'var(--surface-hover-subtle)',
                      borderBottom: '1px solid var(--border-muted)',
                    }}
                  >
                    <span style={{ fontSize: '0.75rem', fontFamily: 'monospace', color: 'var(--text-muted)' }}>
                      {match[1]}
                    </span>
                    <CopyButton text={codeString} label="Copy" />
                  </div>
                  <SyntaxHighlighter
                    language={match[1]}
                    style={effectiveTheme === 'dark' ? vscDarkPlus : oneLight}
                    customStyle={{ margin: 0, padding: '16px', fontSize: '0.85rem' }}
                  >
                    {codeString}
                  </SyntaxHighlighter>
                </div>
              );
            }
            return (
              <code
                className={className}
                style={{
                  background: 'var(--surface-hover)',
                  padding: '2px 6px',
                  borderRadius: '4px',
                  fontFamily: 'monospace',
                  fontSize: '0.85rem',
                }}
                {...props}
              >
                {children}
              </code>
            );
          },
          img({ src, alt, title }: { src?: string; alt?: string; title?: string }) {
            const imageIndex = images.findIndex((image) => image.url === src);
            return (
              <button
                type="button"
                onClick={() => lightbox.openLightbox(images, Math.max(imageIndex, 0))}
                aria-label={`Open image: ${alt || title || 'report image'}`}
                style={{ display: 'block', maxWidth: '100%', padding: 0, border: 0, background: 'transparent', cursor: 'zoom-in' }}
              >
                <img src={src} alt={alt ?? ''} title={title} style={{ maxWidth: '100%', height: 'auto' }} />
              </button>
            );
          },
          a({ href, children }: any) {
            return (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                data-testid="external-link"
                style={{ color: 'var(--accent-cyan)', textDecoration: 'underline' }}
              >
                {children}
              </a>
            );
          },
          table({ children }: any) {
            return (
              <div style={{ overflowX: 'auto', margin: '20px 0' }} data-testid="markdown-table">
                <table
                  style={{
                    width: '100%',
                    borderCollapse: 'collapse',
                    border: '1px solid var(--border-muted)',
                    borderRadius: '8px',
                    overflow: 'hidden',
                  }}
                >
                  {children}
                </table>
              </div>
            );
          },
          tr({ children, ...props }: any) {
            return (
              <tr
                style={{
                  borderBottom: '1px solid var(--border-muted)',
                }}
                className="markdown-tr"
                {...props}
              >
                {children}
              </tr>
            );
          },
          th({ children }: any) {
            return (
              <th
                style={{
                  padding: '10px 14px',
                  background: 'var(--surface-hover)',
                  color: 'var(--text-primary)',
                  fontWeight: 600,
                  textAlign: 'left',
                }}
              >
                {children}
              </th>
            );
          },
          td({ children }: any) {
            return (
              <td
                style={{
                  padding: '10px 14px',
                  color: 'var(--text-primary)',
                  fontSize: '0.9rem',
                }}
              >
                {children}
              </td>
            );
          },
        }}
      >
        {markdown}
      </ReactMarkdown>
    </div>
      <ImageLightbox
        isOpen={lightbox.isOpen}
        images={lightbox.images}
        currentIndex={lightbox.currentIndex}
        scale={lightbox.scale}
        position={lightbox.position}
        onClose={lightbox.closeLightbox}
        onPrev={lightbox.prevImage}
        onNext={lightbox.nextImage}
        onSelectIndex={lightbox.setIndex}
        onZoomIn={lightbox.zoomIn}
        onZoomOut={lightbox.zoomOut}
        onResetZoom={lightbox.resetZoom}
        onWheel={lightbox.handleWheel}
        onPinch={lightbox.handlePinch}
        onPositionChange={lightbox.setPosition}
      />
    </>
  );

  if (isLongReport) {
    return (
      <CollapsibleSection
        title="Research Report Content"
        contentLength={markdown.length}
        maxLength={500}
      >
        {content}
      </CollapsibleSection>
    );
  }

  return content;
};

export default ResearchReportRenderer;
