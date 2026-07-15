import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import App from './App';

const ProductApp = lazy(() => import('./ProductApp').then((module) => ({ default: module.ProductApp })));

export function RootApp() {
  return (
    <Routes>
      <Route path="/" element={<App />} />
      <Route
        path="/*"
        element={(
          <Suspense fallback={<div className="workspace-loading">Opening ORIN AI…</div>}>
            <ProductApp />
          </Suspense>
        )}
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
