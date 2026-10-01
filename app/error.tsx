"use client";

import { ErrorBoundaryView } from "@/components/error-boundary-view";

export default function SegmentError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <ErrorBoundaryView error={error} retry={retry} variant="public" />;
}
