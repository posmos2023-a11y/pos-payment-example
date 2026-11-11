import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import App from './App.tsx';
import { paymentRuntime, realServices } from './sdk.ts';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App services={realServices} runtime={paymentRuntime} />
  </StrictMode>,
);
