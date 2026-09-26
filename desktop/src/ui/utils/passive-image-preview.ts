type Preview = { kind?: string; path?: string; dataUrl?: string; previewUrl?: string };

/** Rendering history may probe exact files, never enumerate unrelated workspaces. */
export async function loadPassiveImagePreview(options: {
  src: string;
  roots: Array<string | null | undefined>;
  load: (cwd: string, path: string) => Promise<unknown>;
  cancelled: () => boolean;
}): Promise<{ kind: 'image' | 'video'; src: string; path: string } | null> {
  const source = options.src.replace(/^\.\//, '');
  const absolute = source.startsWith('/');
  if (!/\.(png|jpe?g|gif|webp|avif|svg|mp4|webm|mov)$/i.test(source)
    || source.split('/').includes('..')) return null;
  const base = source.split('/').pop()!;
  const roots = absolute ? [source.replace(/\/[^/]*$/, '') || '/']
    : [...new Set(options.roots.filter((root): root is string => Boolean(root)))];
  const candidates = absolute ? [source] : [...new Set([source, base, `images/${base}`, `assets/${base}`, `videos/${base}`])];
  for (const root of roots) {
    for (const candidate of candidates) {
      if (options.cancelled()) return null;
      let preview: Preview;
      try { preview = await options.load(root, candidate) as Preview; } catch { continue; }
      if (options.cancelled()) return null;
      if (preview?.kind === 'image' && preview.dataUrl) {
        return { kind: 'image', src: preview.dataUrl, path: preview.path || (absolute ? source : `${root}/${candidate}`) };
      }
      if (preview?.kind === 'video' && preview.previewUrl) {
        return { kind: 'video', src: preview.previewUrl, path: preview.path || (absolute ? source : `${root}/${candidate}`) };
      }
    }
  }
  return null;
}
