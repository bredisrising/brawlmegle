import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { startAnalytics } from './analytics';
import './index.css';

startAnalytics();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
