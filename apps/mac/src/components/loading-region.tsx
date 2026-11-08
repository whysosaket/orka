import React, { createContext, useContext, useEffect } from "react";
import { forgetShapes } from "skullet";
import { Skeleton, SkulletProvider, type SkeletonProps } from "skullet/react";

const LoadingScope = createContext("");
const theme = {
  light: {
    base: "var(--surface-tertiary)",
    highlight: "var(--surface-stroke)",
  },
  dark: { base: "var(--surface-tertiary)", highlight: "var(--surface-stroke)" },
  radius: "var(--radius-detail)",
  animation: "shimmer" as const,
  speed: "slow" as const,
};

/** Share Orka's tokens and clear shapes persisted by earlier app versions. */
export function LoadingProvider({
  scope,
  children,
}: {
  scope: string;
  children: React.ReactNode;
}) {
  useEffect(() => {
    forgetShapes();
    return () => forgetShapes();
  }, [scope]);
  return (
    <LoadingScope.Provider value={scope}>
      <SkulletProvider theme={theme} reveal="smart">
        {children}
      </SkulletProvider>
    </LoadingScope.Provider>
  );
}

/** Measure presentation children only; background fetches should keep their data. */
export function LoadingRegion<T>(
  props: SkeletonProps<T> & { label: string; id: string },
) {
  const scope = useContext(LoadingScope);
  const pending =
    !props.error &&
    !props.empty &&
    (props.loading ||
      (typeof props.children === "function" && props.data == null));
  return (
    <>
      <span className="sr-only" role={pending ? "status" : undefined}>
        {pending ? props.label : ""}
      </span>
      <Skeleton
        {...props}
        key={`${scope}:${props.id}`}
        // In pinned Skullet 0.0.3, an empty ID disables shape storage; omitting
        // it instead derives a storage key from the DOM, including raw URLs.
        id=""
        label={undefined}
        className={`loading-region ${props.className ?? ""}`}
      />
    </>
  );
}
