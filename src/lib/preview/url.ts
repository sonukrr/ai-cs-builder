/**
 * Builds the URL for the Angular preview host, embedding only what it reads at
 * boot: project id, the studio's own origin (so it knows where to postMessage
 * selection back to), the data source, and a cache-busting reload token.
 *
 * Shared by the in-studio iframe (`PreviewFrame`) and the full-page preview
 * tab so the two never diverge on how the URL is put together.
 */
export function buildPreviewUrl(input: {
  previewOrigin: string;
  projectId: string;
  studioOrigin: string;
  reloadKey?: number;
}): string {
  const { previewOrigin, projectId, studioOrigin, reloadKey = 0 } = input;
  return `${previewOrigin}/?project=${encodeURIComponent(projectId)}&studio=${encodeURIComponent(
    studioOrigin,
  )}&source=live&v=${reloadKey}`;
}

/** The cross-tab channel a project's studio and full-preview tab share. */
export function previewChannelName(projectId: string): string {
  return `studio-preview-${projectId}`;
}
