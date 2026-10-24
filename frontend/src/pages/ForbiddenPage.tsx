import React from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { ForbiddenIllustration } from '../components/common/ErrorIllustration';
import styles from './ErrorPage.module.css';

/**
 * 403 Forbidden page.
 *
 * Shown when a user tries to access a page they don't have permission to view.
 * The HTTP status code is not displayed to end users.
 */
export const ForbiddenPage: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();

  return (
    <div className={styles.page}>
      <div className={styles.illustrationWrapper}>
        <ForbiddenIllustration ariaLabel={t('errorPage.imageAlt.forbidden')} />
      </div>

      <h1 className={styles.heading}>
        {t('page.forbidden.title')}
      </h1>

      <p className={styles.body}>
        {t('page.forbidden.body')}
      </p>

      <div className={styles.actions}>
        <button
          className={styles.primaryButton}
          onClick={() => navigate('/wallet')}
          type="button"
        >
          {t('page.forbidden.connectWallet')}
        </button>

        <button
          className={styles.secondaryButton}
          onClick={() => navigate('/dashboard')}
          type="button"
        >
          {t('page.forbidden.goDashboard')}
        </button>
      </div>
    </div>
  );
};

export default ForbiddenPage;
