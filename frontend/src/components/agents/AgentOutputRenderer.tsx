import React, { Suspense, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Capability, AgentResult, ResearchReportResult, CodingResult, RiskResult, DesignResult } from '../../types/agent';
import RiskMatrix from './RiskMatrix';
import DesignRenderer from './DesignRenderer';
import { Maximize2, Minimize2, Search, Clock, Cpu, Sparkles, X } from 'lucide-react';

const ResearchReportRenderer = React.lazy(() => import('./ResearchReportRenderer'));
const CodingRenderer = React.lazy(() => import('./CodingRenderer'));

interface Props {
  agentType: Capability;
  result: AgentResult;
  agentName?: string;
  executionTimeMs?: number;
  tokenCount?: number;
}

const LoadingFallback: React.FC = () => {
  const { t } = useTranslation();
  return (
    <div
      style={{
        padding: '24px',
        color: 'var(--text-secondary)',
        fontStyle: 'italic',
        fontSize: '0.9rem',
      }}
    >
      {t('agent.output.loadingRenderer')}
    </div>
  );
};

const getAgentDisplayName = (type: Capability, customName?: string): string => {
  if (customName) return customName;
  switch (type) {
    case 'research':
    case 'report':
      return 'Research Agent';
    case 'coding':
      return 'Coding Agent';
    case 'design':
      return 'Design Agent';
    case 'risk':
      return 'Risk Matrix Agent';
    default:
      return `${type} Agent`;
  }
};

const AgentOutputRenderer: React.FC<Props> = ({
  agentType,
  result,
  agentName,
  executionTimeMs,
  tokenCount,
}) => {
  const { t } = useTranslation();
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [isFullScreen, setIsFullScreen] = useState<boolean>(false);
  const displayName = getAgentDisplayName(agentType, agentName);
  // All renderers handle null/undefined result with an empty-state placeholder
  if (result === null || result === undefined) {
    return (
      <div
        className="empty-state"
        id={`empty-${agentType}`}
        style={{
          padding: '24px',
          textAlign: 'center',
          color: 'var(--text-secondary)',
          background: 'var(--white-alpha-02)',
          borderRadius: '8px',
          border: '1px dashed var(--white-alpha-10)',
        }}
      >
        {t('agent.output.empty')}
      </div>
    );
  }

  const renderContent = () => {
    switch (agentType) {
      case 'research':
      case 'report':
        return (
          <Suspense fallback={<LoadingFallback />}>
            <ResearchReportRenderer
              result={result as ResearchReportResult}
              searchQuery={searchQuery}
            />
          </Suspense>
        );
      case 'coding':
        return (
          <Suspense fallback={<LoadingFallback />}>
            <CodingRenderer
              result={result as CodingResult}
              searchQuery={searchQuery}
            />
          </Suspense>
        );
      case 'risk':
        return <RiskMatrix result={result as RiskResult} />;
      case 'design':
        return (
          <DesignRenderer
            result={result as DesignResult}
            searchQuery={searchQuery}
          />
        );
      default:
        return (
          <div style={{ color: 'var(--danger)', padding: '12px' }}>
            Unknown agent type: {agentType}
          </div>
        );
    }
  };

  const formattedTime =
    executionTimeMs !== undefined
      ? executionTimeMs >= 1000
        ? `${(executionTimeMs / 1000).toFixed(2)}s`
        : `${executionTimeMs}ms`
      : null;

  const headerContainerStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: '12px',
    padding: '12px 16px',
    backgroundColor: 'var(--surface-panel-translucent)',
    border: '1px solid var(--border-muted)',
    borderRadius: '10px',
    marginBottom: '16px',
    backdropFilter: 'blur(8px)',
  };

  const fullScreenOverlayStyle: React.CSSProperties = {
    position: 'fixed',
    inset: 0,
    zIndex: 9990,
    background: 'var(--surface-overlay)',
    backdropFilter: 'blur(16px)',
    WebkitBackdropFilter: 'blur(16px)',
    display: 'flex',
    flexDirection: 'column',
    padding: '24px',
    overflow: 'hidden',
  };

  const headerControls = (
    <div className="agent-output-header" data-testid="agent-output-header" style={headerContainerStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <Sparkles size={16} color="var(--accent-cyan)" />
          <span style={{ fontWeight: 700, fontSize: '0.95rem', color: 'var(--text-primary)' }} data-testid="agent-name">
            {displayName}
          </span>
        </div>

        {formattedTime && (
          <span
            data-testid="execution-time"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '4px',
              fontSize: '0.75rem',
              color: 'var(--text-secondary)',
              background: 'var(--surface-hover)',
              padding: '3px 8px',
              borderRadius: '6px',
              fontFamily: 'monospace',
            }}
          >
            <Clock size={12} />
            <span>{formattedTime}</span>
          </span>
        )}

        {tokenCount !== undefined && (
          <span
            data-testid="token-count"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '4px',
              fontSize: '0.75rem',
              color: 'var(--accent-text-strong)',
              background: 'var(--accent-surface-muted)',
              border: '1px solid var(--accent-border)',
              padding: '3px 8px',
              borderRadius: '6px',
              fontFamily: 'monospace',
              fontWeight: 600,
            }}
          >
            <Cpu size={12} />
            <span>{tokenCount.toLocaleString()} tokens</span>
          </span>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
          <Search
            size={14}
            color="var(--text-secondary)"
            style={{ position: 'absolute', left: '10px', pointerEvents: 'none' }}
          />
          <input
            type="text"
            placeholder="Search output..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            data-testid="output-search-input"
            style={{
              padding: '5px 10px 5px 30px',
              fontSize: '0.8rem',
              borderRadius: '6px',
              border: '1px solid var(--border-muted)',
              background: 'var(--surface-canvas)',
              color: 'var(--text-primary)',
              outline: 'none',
              width: '160px',
            }}
          />
        </div>

        <button
          type="button"
          onClick={() => setIsFullScreen((prev) => !prev)}
          data-testid="fullscreen-toggle-btn"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '4px',
            background: isFullScreen ? 'var(--info-surface)' : 'var(--surface-hover)',
            border: isFullScreen ? '1px solid var(--info-border)' : '1px solid var(--border-muted)',
            color: 'var(--text-primary)',
            padding: '5px 10px',
            borderRadius: '6px',
            cursor: 'pointer',
            fontSize: '0.8rem',
            fontWeight: 600,
            transition: 'all 0.2s ease',
          }}
          title={isFullScreen ? 'Exit Fullscreen' : 'Full-screen Review'}
        >
          {isFullScreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          <span>{isFullScreen ? 'Exit' : 'Full Screen'}</span>
        </button>
      </div>
    </div>
  );

  if (isFullScreen) {
    return (
      <div
        className="fullscreen-output-overlay"
        data-testid="fullscreen-output-overlay"
        style={fullScreenOverlayStyle}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
          {headerControls}
          <button
            type="button"
            onClick={() => setIsFullScreen(false)}
            data-testid="fullscreen-close-btn"
            style={{
              background: 'var(--status-danger-surface)',
              border: '1px solid var(--status-danger-border)',
              color: 'var(--status-danger-text)',
              borderRadius: '6px',
              padding: '6px 12px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
            }}
          >
            <X size={16} />
            <span>Close</span>
          </button>
        </div>

        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '24px',
            background: 'var(--surface-panel-strong)',
            border: '1px solid var(--border-muted)',
            borderRadius: '12px',
          }}
        >
          {renderContent()}
        </div>
      </div>
    );
  }

  return (
    <div className="agent-output-renderer-wrapper" data-testid="agent-output-wrapper">
      {headerControls}
      <div className="agent-output-body">{renderContent()}</div>
    </div>
  );
};

export default AgentOutputRenderer;
