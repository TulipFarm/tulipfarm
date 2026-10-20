import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Button } from '@tulipfarm/sprout/button';
import { Input } from '@tulipfarm/sprout/input';
import { FileViewer } from '@tulipfarm/sprout/file-viewer';
import { MessageResponse } from '@tulipfarm/sprout/message-response';
import { fileRenderers } from '../src/features/files/viewer/renderers';
import type { ViewableFile } from '../src/lib/file-viewer';
import '../src/index.css';

function RenderingFixture() {
  const [file, setFile] = useState<ViewableFile | null>(null);
  const [streaming, setStreaming] = useState(true);
  const [version, setVersion] = useState(1);
  const [link, setLink] = useState('first');
  const [clicked, setClicked] = useState('');
  return (
    <main>
      <Input
        type="file"
        aria-label="Local document"
        onChange={event => {
          const next = event.target.files?.[0];
          if (next) setFile({ name: next.name, mediaType: next.type, source: { kind: 'local', file: next } });
        }}
      />
      <Button
        onClick={() =>
          setFile({
            name: 'retry.docx',
            mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            source: { kind: 'remote', url: '/retry.docx' },
          })
        }
      >
        Open retry document
      </Button>
      <Button onClick={() => setStreaming(value => !value)}>Toggle streaming</Button>
      <Button onClick={() => setVersion(value => value + 1)}>Append response</Button>
      <Button onClick={() => setLink('second')}>Change link authority</Button>
      <output aria-label="Selected link">{clicked}</output>
      <MessageResponse
        streaming={streaming}
        renderLink={(_href, children) => (
          <Button variant="link" onClick={() => setClicked(link)}>
            {children}
          </Button>
        )}
      >{`## Revision ${version}\n\n[Download](https://example.test/file)\n\n| Customer | State |\n| --- | --- |\n| Cedar | Ready |\n\n<script>window.injected = true</script>\n\n![private](https://example.test/private.png)`}</MessageResponse>
      <FileViewer
        file={file}
        renderers={fileRenderers}
        open={file !== null}
        onOpenChange={open => {
          if (!open) setFile(null);
        }}
      />
    </main>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('Missing rendering fixture root');
createRoot(root).render(<RenderingFixture />);
