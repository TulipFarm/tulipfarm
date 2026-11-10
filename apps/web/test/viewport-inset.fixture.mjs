import { createElement as h, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useViewportInset } from '../src/lib/viewport-inset.ts';
import '../src/index.css';

export function mountInsets() {
  const root = createRoot(document.getElementById('root'));
  let update;
  function Fixture() {
    const [state, setState] = useState({ height: 48, floating: true, consent: false, renders: 0 });
    update = changes => setState(previous => ({ ...previous, ...changes }));
    const floating = useRef(null);
    const consent = useRef(null);
    useViewportInset(floating, '--floating-bottom-inset', { enabled: state.floating, gap: 32 });
    useViewportInset(consent, '--consent-inset', { enabled: state.consent });
    return h(
      'div',
      { className: 'workspace-viewport grid h-svh grid-rows-1 overflow-hidden' },
      h(
        'main',
        { 'data-viewport-content': '', style: { overflowY: 'auto', minHeight: 0 } },
        h('div', { style: { height: 1500 } }, `Page content ${state.renders}`),
        h(
          'footer',
          { className: 'sticky bottom-0', style: { background: 'white', padding: 16 } },
          h('button', { type: 'button', onClick: event => (event.currentTarget.textContent = 'Saved') }, 'Save'),
        ),
      ),
      state.floating &&
        h(
          'aside',
          {
            ref: floating,
            'aria-label': 'Floating control',
            style: {
              position: 'fixed',
              bottom: 'calc(16px + max(var(--consent-inset, 0px), env(safe-area-inset-bottom, 0px)))',
              right: 16,
              height: state.height,
              width: 160,
              background: 'white',
            },
          },
          h('button', { type: 'button' }, 'Quick chat'),
        ),
      state.consent &&
        h(
          'aside',
          { ref: consent, style: { position: 'fixed', insetInline: 0, bottom: 0, height: 160 } },
          h('button', { type: 'button', onClick: () => update({ consent: false }) }, 'Dismiss consent'),
        ),
    );
  }
  root.render(h(Fixture));
  return { update: changes => update(changes), close: () => root.unmount() };
}
