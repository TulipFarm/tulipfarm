import { init } from 'pptx-preview';
import { pptxPreviewBytes } from '../src/features/files/viewer/pptx-preview-bytes';

export async function renderPptx(base64: string) {
  const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0)).buffer;
  const container = document.createElement('div');
  document.body.replaceChildren(container);
  const renderer = init(container, { width: 960, height: 540, mode: 'list' });
  await renderer.preview(await pptxPreviewBytes(bytes));
  await new Promise(resolve => setTimeout(resolve, 500));
  // oxlint-disable-next-line tulipfarm/product-copy -- pptx-preview's own class name
  const slides = [...container.querySelectorAll('.pptx-preview-slide-wrapper')].map(slide =>
    [...slide.querySelectorAll('.chart-node')].map(chart => ({
      shapes: chart.querySelectorAll('svg path, canvas').length,
      labels: [...chart.querySelectorAll('svg text')].map(text => text.textContent),
    })),
  );
  renderer.destroy();
  return slides;
}
