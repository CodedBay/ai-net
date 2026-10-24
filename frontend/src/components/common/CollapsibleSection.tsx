import React, { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

export interface CollapsibleSectionProps {
  title?: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  maxLength?: number;
  contentLength?: number;
  className?: string;
  style?: React.CSSProperties;
}

export const CollapsibleSection: React.FC<CollapsibleSectionProps> = ({
  title = 'Section Content',
  children,
  defaultOpen,
  maxLength = 500,
  contentLength,
  className = '',
  style = {},
}) => {
  const isLongContent = contentLength !== undefined ? contentLength > maxLength : false;
  const initialOpen = defaultOpen !== undefined ? defaultOpen : !isLongContent;
  const [isOpen, setIsOpen] = useState<boolean>(initialOpen);

  const toggle = () => setIsOpen((prev) => !prev);

  const containerStyle: React.CSSProperties = {
    border: '1px solid var(--border-muted)',
    borderRadius: '8px',
    backgroundColor: 'var(--surface-glass)',
    marginBottom: '16px',
    overflow: 'hidden',
    ...style,
  };

  const headerStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '10px 14px',
    backgroundColor: 'var(--surface-hover-subtle)',
    cursor: 'pointer',
    userSelect: 'none',
    transition: 'background-color 0.2s ease',
  };

  return (
    <div className={`collapsible-section ${className}`} data-testid="collapsible-section" style={containerStyle}>
      <div
        className="collapsible-header"
        data-testid="collapsible-header"
        onClick={toggle}
        style={headerStyle}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {isOpen ? (
            <ChevronDown size={16} color="var(--accent-cyan)" />
          ) : (
            <ChevronRight size={16} color="var(--text-secondary)" />
          )}
          <span style={{ fontWeight: 600, fontSize: '0.9rem', color: 'var(--text-primary)' }}>
            {title}
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {contentLength !== undefined && (
            <span
              style={{
                fontSize: '0.75rem',
                color: 'var(--text-secondary)',
                fontFamily: 'monospace',
                background: 'var(--surface-hover)',
                padding: '2px 8px',
                borderRadius: '4px',
              }}
            >
              {contentLength.toLocaleString()} chars
            </span>
          )}
          <span style={{ fontSize: '0.75rem', color: 'var(--accent-cyan)', fontWeight: 500 }}>
            {isOpen ? 'Collapse' : 'Expand'}
          </span>
        </div>
      </div>

      {isOpen && (
        <div className="collapsible-content" data-testid="collapsible-content" style={{ padding: '16px' }}>
          {children}
        </div>
      )}
    </div>
  );
};

export default CollapsibleSection;
