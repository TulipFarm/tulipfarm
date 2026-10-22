import { useEffect, useRef, useState } from 'react';
import { FileError, LoadingFile, type FileOfficeRendererProps } from '@tulipfarm/sprout/file-viewer';

export default function OfficeFile({ bytes, kind, name, onRetry }: FileOfficeRendererProps) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [documentVersion, setDocumentVersion] = useState(0);
  const [width, setWidth] = useState(0);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  useEffect(() => {
    if (!frame.current) return;
    const observer = new ResizeObserver(entries => {
      const measured = entries[0]?.contentRect.width;
      if (measured && measured > 0) setWidth(Math.floor(measured));
    });
    observer.observe(frame.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const document = frame.current?.contentDocument;
    if (!documentVersion || !document || !width) return;
    setState('loading');
    const container = document.createElement('div');
    document.body.replaceChildren(container);
    let cancelled = false;
    let dispose: (() => void) | undefined;
    const render = async () => {
      if (kind === 'slides') {
        const [{ init }, { pptxPreviewBytes }] = await Promise.all([
          import('pptx-preview'),
          import('./pptx-preview-bytes'),
        ]);
        if (cancelled) return;
        const slideWidth = Math.max(1, width - 32);
        const renderer = init(container, {
          width: slideWidth,
          height: Math.round((slideWidth * 9) / 16),
          mode: 'list',
        });
        dispose = () => renderer.destroy();
        const previewBytes = await pptxPreviewBytes(bytes);
        if (cancelled) return;
        await renderer.preview(previewBytes);
        if (!container.querySelector('[class*="slide-wrapper"]')) throw new Error('No slides rendered');
        const list = container.firstElementChild as HTMLElement | null;
        if (list) {
          list.style.height = 'auto';
          list.style.overflowY = 'visible';
        }
      } else {
        const { renderAsync } = await import('docx-preview');
        if (cancelled) return;
        await renderAsync(bytes.slice(0), container, undefined, {
          useBase64URL: true,
          renderAltChunks: false,
          ignoreWidth: document.documentElement.clientWidth < 800,
        });
      }
      if (!cancelled) setState('ready');
    };
    void render().catch(() => {
      if (!cancelled) setState('error');
    });
    return () => {
      cancelled = true;
      dispose?.();
      container.remove();
    };
  }, [bytes, kind, documentVersion, width]);
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {state === 'loading' && (
        <div className="absolute inset-x-0 top-0 z-10 bg-background/95">
          <LoadingFile />
        </div>
      )}
      {state === 'error' && (
        <FileError
          message="This Office file could not be rendered. It may be damaged, encrypted, or use unsupported formatting."
          onRetry={onRetry}
        />
      )}
      <iframe
        ref={frame}
        title={`${name} document`}
        sandbox="allow-same-origin"
        srcDoc={
          '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data: blob:; style-src \'unsafe-inline\'; font-src data: blob:"><style>html{color-scheme:light;background:#eee;font-family:system-ui}body{margin:0;padding:16px;overflow:auto}img{max-width:100%}</style></head><body></body></html>'
        }
        onLoad={() => setDocumentVersion(value => value + 1)}
        className={state === 'error' ? 'hidden' : 'min-h-0 w-full flex-1 border-0'}
      />
    </div>
  );
}
