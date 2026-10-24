import React, { useState } from 'react';
import { Copy, Check } from 'lucide-react';

export interface CopyButtonProps {
  text: string;
  label?: string;
  copiedLabel?: string;
  className?: string;
  style?: React.CSSProperties;
  iconSize?: number;
}

export const CopyButton: React.FC<CopyButtonProps> = ({
  text,
  label = 'Copy',
  copiedLabel = '✓ Copied!',
  className = '',
  style = {},
  iconSize = 14,
}) => {
  const [copied, setCopied] = useState<boolean>(false);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy to clipboard', err);
    }
  };

  const buttonStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    background: copied ? 'var(--status-success)' : 'var(--surface-hover)',
    border: '1px solid var(--border-muted)',
    color: 'var(--text-primary)',
    padding: '5px 10px',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '0.8rem',
    fontWeight: 600,
    transition: 'all 0.2s ease',
    outline: 'none',
    userSelect: 'none',
    ...style,
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={`copy-btn ${className}`}
      data-testid="copy-button"
      style={buttonStyle}
      title="Copy to clipboard"
    >
      {copied ? <Check size={iconSize} /> : <Copy size={iconSize} />}
      <span>{copied ? copiedLabel : label}</span>
    </button>
  );
};

export default CopyButton;
