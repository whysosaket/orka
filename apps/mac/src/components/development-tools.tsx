import React, { lazy, Suspense, useState } from "react";

// The gallery opens with ?design-system in development; it has no sidebar entry.
// Vite removes this import from production builds.
const DesignSystem = import.meta.env.DEV
  ? lazy(() => import("./design-system.js"))
  : null;

export function DevelopmentTools({ children }: { children: React.ReactNode }) {
  const [designSystem, setDesignSystem] = useState(
    import.meta.env.DEV &&
      new URLSearchParams(window.location.search).has("design-system"),
  );
  return (
    <>
      {children}
      {DesignSystem && designSystem && (
        <Suspense fallback={null}>
          <DesignSystem onClose={() => setDesignSystem(false)} />
        </Suspense>
      )}
    </>
  );
}
