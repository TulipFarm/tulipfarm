import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addedMessage,
  confirmUploads,
  createUploadQueue,
  queueUploads,
  sendUploads,
  uploadSummary,
  type Upload,
} from '../src/features/projects/uploads.ts';

const files = (...names: string[]) => names.map(name => new File([`${name} text`], name, { type: 'text/plain' }));
const kinds = (uploads: readonly Upload[]) => uploads.map(upload => upload.state.kind).join(' ');
class Rejected extends Error {}
const rejection = (error: unknown) => (error instanceof Rejected ? error.message : null);

test('a rejected or unconfirmed file does not stop the files after it, and each outcome is shown', async () => {
  const sent: string[] = [];
  const shown: string[] = [];
  const done = await sendUploads(
    queueUploads(files('notes.txt', 'scan.docx', 'minutes.txt', 'prices.txt')),
    async upload => {
      sent.push(upload.file.name);
      if (upload.file.name === 'scan.docx') throw new Rejected('TulipFarm could not read text from this file.');
      if (upload.file.name === 'minutes.txt') throw new TypeError('Failed to fetch');
    },
    rejection,
    uploads => shown.push(kinds(uploads)),
  );
  assert.deepEqual(sent, ['notes.txt', 'scan.docx', 'minutes.txt', 'prices.txt']);
  assert.deepEqual(shown, [
    'sending waiting waiting waiting',
    'added waiting waiting waiting',
    'added sending waiting waiting',
    'added rejected waiting waiting',
    'added rejected sending waiting',
    'added rejected uncertain waiting',
    'added rejected uncertain sending',
    'added rejected uncertain added',
  ]);
  assert.deepEqual(
    done.map(upload => upload.state),
    [
      { kind: 'added' },
      { kind: 'rejected', message: 'TulipFarm could not read text from this file.' },
      {
        kind: 'uncertain',
        message: 'We couldn’t confirm whether it was added. Retry sends the same file without adding a copy.',
      },
      { kind: 'added' },
    ],
  );
  assert.equal(uploadSummary(done), '2 added, 1 not added, 1 not confirmed');
});

test('a retry sends only the unconfirmed file with its first ids, so the server keeps one copy', async () => {
  const stored = new Map<string, string>();
  const attempts: string[] = [];
  let lose = 'minutes.txt';
  const server = async (upload: Upload) => {
    attempts.push(`${upload.file.name} ${upload.id} ${upload.revisionId}`);
    const prior = stored.get(upload.id);
    if (prior && prior !== upload.revisionId) throw new Rejected('Conflict');
    stored.set(upload.id, upload.revisionId);
    if (upload.file.name === lose) {
      lose = '';
      throw new TypeError('Failed to fetch');
    }
  };
  const queued = queueUploads(files('minutes.txt', 'budget.txt'));
  const [minutes, budget] = queued as [Upload, Upload];
  const summaries: string[] = [];
  const first = await sendUploads(queued, server, rejection, uploads => summaries.push(uploadSummary(uploads)));
  assert.equal(summaries[0], 'Adding minutes.txt…');
  assert.equal(uploadSummary(first), '1 added, 1 not confirmed');
  const retried = await sendUploads(
    first.map(upload => (upload.id === minutes.id ? { ...upload, state: { kind: 'waiting' } } : upload)),
    server,
    rejection,
    () => {},
  );
  assert.equal(uploadSummary(retried), '2 added');
  assert.deepEqual(attempts, [
    `minutes.txt ${minutes.id} ${minutes.revisionId}`,
    `budget.txt ${budget.id} ${budget.revisionId}`,
    `minutes.txt ${minutes.id} ${minutes.revisionId}`,
  ]);
  assert.equal(stored.size, 2);
});

test('a file whose ids appear among the saved files counts as added, even after a rejected retry', () => {
  const [lost, missing, rejected] = queueUploads(files('minutes.txt', 'agenda.txt', 'scan.docx'));
  const uploads: Upload[] = [
    { ...lost!, state: { kind: 'uncertain', message: 'Not confirmed' } },
    { ...missing!, state: { kind: 'uncertain', message: 'Not confirmed' } },
    { ...rejected!, state: { kind: 'rejected', message: 'This project is archived.' } },
  ];
  const saved = [
    { id: lost!.id, revisionId: lost!.revisionId },
    { id: missing!.id, revisionId: crypto.randomUUID() },
    { id: rejected!.id, revisionId: rejected!.revisionId },
  ];
  const confirmed = confirmUploads(uploads, saved);
  assert.deepEqual(
    confirmed.map(upload => upload.state.kind),
    ['added', 'uncertain', 'added'],
  );
  assert.equal(uploadSummary(confirmed), '2 added, 1 not confirmed');
  assert.strictEqual(
    confirmUploads(confirmed, saved.slice(0, 1)),
    confirmed,
    'nothing left to confirm returns the same list',
  );
  assert.equal(addedMessage(confirmed.slice(0, 1)), 'minutes.txt added.');
  assert.equal(addedMessage(confirmed), '3 files added.');
});

test('a project batch keeps its results after the page leaves, refuses a second batch while sending, and warns only while sending', async () => {
  const warnings: boolean[] = [];
  const queue = createUploadQueue(active => warnings.push(active));
  const key = 'membership-1 project-1';
  const gate = Promise.withResolvers<void>();
  const sent: string[] = [];
  const server = async (upload: Upload) => {
    sent.push(upload.file.name);
    if (upload.file.name === 'notes.txt') await gate.promise;
    if (upload.file.name === 'scan.docx') throw new Rejected('TulipFarm could not read text from this file.');
    if (upload.file.name === 'minutes.txt') throw new TypeError('Failed to fetch');
  };
  const first = queue.send(key, queueUploads(files('notes.txt', 'scan.docx', 'minutes.txt')), server, rejection);
  assert.equal(queue.batch(key).running, true);
  assert.equal(uploadSummary(queue.batch(key).uploads), 'Adding notes.txt…');
  assert.equal(
    await queue.send(key, queueUploads(files('notes.txt')), server, rejection),
    null,
    'a second batch waits for the first',
  );
  assert.deepEqual(
    queue.batch('membership-1 project-2'),
    { uploads: [], running: false },
    'another project has its own batch',
  );
  queue.replace(key, []);
  assert.equal(queue.batch(key).uploads.length, 3, 'a running batch cannot be dismissed');
  gate.resolve();
  await first;
  const finished = queue.batch(key);
  assert.equal(finished.running, false);
  assert.equal(uploadSummary(finished.uploads), '1 added, 1 not added, 1 not confirmed');
  assert.deepEqual(sent, ['notes.txt', 'scan.docx', 'minutes.txt']);
  assert.deepEqual(warnings, [true, false]);

  const minutes = finished.uploads[2]!;
  await queue.send(
    key,
    finished.uploads.map(upload => (upload.id === minutes.id ? { ...upload, state: { kind: 'waiting' } } : upload)),
    async () => {},
    rejection,
  );
  assert.equal(uploadSummary(queue.batch(key).uploads), '2 added, 1 not added');
  assert.equal(queue.batch(key).uploads[2]!.revisionId, minutes.revisionId, 'the retry keeps its ids');
  queue.replace(key, []);
  assert.deepEqual(queue.batch(key), { uploads: [], running: false });
  assert.deepEqual(warnings, [true, false, true, false]);
});
