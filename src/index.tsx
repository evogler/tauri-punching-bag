import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';
import reportWebVitals from './reportWebVitals';
import { initPlatform } from './platform';
import { initLegacyInputCount } from './presets';

const root = ReactDOM.createRoot(
  document.getElementById('root') as HTMLElement
);
// The platform first, so nothing renders a Mac-only section on iOS for a frame;
// and the input count, which a restored session's old channel numbers are read
// against.
Promise.allSettled([initPlatform(), initLegacyInputCount()]).finally(() =>
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
);

// If you want to start measuring performance in your app, pass a function
// to log results (for example: reportWebVitals(console.log))
// or send to an analytics endpoint. Learn more: https://bit.ly/CRA-vitals
reportWebVitals();
