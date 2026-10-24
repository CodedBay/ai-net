import React from 'react';
import { useTranslation } from 'react-i18next';
import { ServerErrorIllustration } from '../components/common/ErrorIllustration';
import styles from './ErrorPage.module.css';

interface ServerErrorPageProps {
  /** Error object passed by an error boundary. Not displayed to users. */
  error?: Error | unknown;
  /** Retry callback — used when rendered inside an error boundary. */
  onRetry?: () => void;
}

/**
 * 500 Server Error page.
 *
 * Can be used both as a routed page (no props) and as the fallback UI rendered
 * by an error boundary (with `error` + `onRetry` props). The HTTP status code
 * is intentionally not shown to end users; it is logged internally via the
 * `error` prop when provided.
 */
export const ServerErrorPage: React.FC<ServerErrorPageProps> = ({ error, onRetry }) => {
  const { t } = useTranslation();

  // Log internally without displaying to the user
  React.useEffect(() => {
    if (error) {
      console.error('[ServerErrorPage] Unhandled error:', error);
    }
  }, [error]);

  const handleRetry = () => {
    if (onRetry) {
      onRetry();
    } else {
      window.location.reload();
    }
  };

  const handleReportIssue = () => {
    const issueUrl =
      'https://github.com/CodedSceptre/ai-net/issues/new?' +
      'template=bug_report.md&labels=bug&title=App+error';
    window.open(issueUrl, '_blank', 'noopener,noreferrer');
  };

  return (
    <div className={styles.page}>
      <div className={styles.illustrationWrapper}>
        <ServerErrorIllustration ariaLabel={t('errorPage.imageAlt.serverError')} />
      </div>

      <h1 className={styles.heading}>
        {t('page.serverError.title')}
      </h1>

      <p className={styles.body}>
        {t('page.serverError.body')}
      </p>

      <div className={styles.actions}>
        <button
          className={styles.primaryButton}
          onClick={handleRetry}
          type="button"
        >
          {t('page.serverError.retry')}
        </button>

        <button
          className={styles.secondaryButton}
          onClick={handleReportIssue}
          type="button"
        >
          {t('page.serverError.reportIssue')}
        </button>
      </div>
    </div>
  );
};

export default ServerErrorPage;
