import React from 'react';
import ReactDOM from 'react-dom/client';
import AuthGate from './AuthGate';
import PublicFunding from './PublicFunding';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>{/^\/funding\/?$/.test(window.location.pathname) ? <PublicFunding /> : <AuthGate />}</React.StrictMode>,
);
