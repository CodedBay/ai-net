import React from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { NotFoundIllustration } from '../components/common/ErrorIllustration';
import styles from './ErrorPage.module.css';

export const NotFoundPage: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();

  return (
    <div className={styles.page}>
      <div className={styles.illustrationWrapper}>
        <NotFoundIllustration ariaLabel={t('errorPage.imageAlt.notFound')} />
      </div>

      <h1 className={styles.heading}>
        {t('page.notFound.title')}
      </h1>

      <p className={styles.body}>
        {t('page.notFound.body')}
      </p>

      <div className={styles.actions}>
        <button
          className={styles.primaryButton}
          onClick={() => navigate('/dashboard')}
          type="button"
        >
          {t('page.notFound.goDashboard')}
        </button>

        <Link to="/agents" className={styles.secondaryButton}>
          {t('page.notFound.searchAgents')}
        </Link>
      </div>
    </div>
  );
};

export default NotFoundPage;
