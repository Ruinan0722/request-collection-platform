import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { ErrorBoundary } from '@shared/components/ErrorBoundary';
import { AuthProvider } from '@shared/auth/AuthContext';
import { installGlobalErrorHandlers, logger } from '@shared/logger/index';
import './styles/global.css';

installGlobalErrorHandlers();
logger.info('前端应用启动');

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('根节点 #root 不存在');
}

createRoot(rootEl).render(
  <StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </ErrorBoundary>
  </StrictMode>,
);
