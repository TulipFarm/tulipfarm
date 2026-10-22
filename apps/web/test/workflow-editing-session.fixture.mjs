import { act, createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useWorkflowEditingSession } from '../src/features/workflows/editing-session';

export async function mountEditingSession(input) {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const events = [];
  let editing, update;
  function Harness() {
    const [props, setProps] = useState({
      initialProvider: false,
      link: {},
      workflows: null,
      archivedWorkflows: null,
      archivedOpened: false,
      archivedState: 'loading',
      ...input,
    });
    update = changes => setProps(current => ({ ...current, ...changes }));
    editing = useWorkflowEditingSession({
      ...props,
      onLink: link => {
        events.push(['link', link]);
        update({ link });
      },
      onOpen: () => events.push(['open']),
      onRun: run => events.push(['run', run]),
      onArchivedLink: () => events.push(['archived']),
      onArchiveLookup: () => {
        events.push(['lookup']);
        update({ archivedOpened: true });
      },
      onMessage: message => events.push(['message', message]),
    });
    return null;
  }
  const root = createRoot(document.getElementById('hook'));
  await act(async () => root.render(createElement(Harness)));
  return {
    snapshot: () => JSON.parse(JSON.stringify({ ...editing, events })),
    call: async (method, args) => {
      let result;
      await act(async () => {
        result = editing[method](...args);
      });
      return result;
    },
    update: async changes => {
      await act(async () => update(changes));
    },
    close: async () => {
      await act(async () => root.unmount());
    },
  };
}
