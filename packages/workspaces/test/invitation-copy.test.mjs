import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { decryptInvitationCopy, encryptInvitationCopy } from '../src/invitation-copy.ts';
import { decryptEmailDelivery } from '../src/email-delivery.ts';

test('copy material binds purpose, workspace, invitation and key and survives retained-key rotation', () => {
  const workspace = randomUUID();
  const invitation = randomUUID();
  const token = `https://original.example/invite?token=${workspace}.${randomBytes(32).toString('base64url')}`;
  const keys = { keyId: 'old', key: randomBytes(32), previous: new Map() };
  const encrypted = encryptInvitationCopy(workspace, invitation, token, keys);
  assert.equal(JSON.stringify(encrypted).includes(token), false);
  assert.equal(decryptInvitationCopy(workspace, invitation, encrypted, keys), token);
  assert.throws(() => decryptInvitationCopy(randomUUID(), invitation, encrypted, keys), /Invitation copy unavailable/);
  assert.throws(() => decryptInvitationCopy(workspace, randomUUID(), encrypted, keys), /Invitation copy unavailable/);
  assert.throws(() => decryptEmailDelivery(invitation, encrypted, keys), /Email payload unavailable/);
  assert.throws(
    () =>
      decryptInvitationCopy(
        workspace,
        invitation,
        { ...encrypted, keyId: 'alias' },
        { ...keys, previous: new Map([['alias', keys.key]]) },
      ),
    /Invitation copy unavailable/,
  );
  assert.throws(
    () => decryptInvitationCopy(workspace, invitation, { ...encrypted, tag: randomBytes(16).toString('base64') }, keys),
    /Invitation copy unavailable/,
  );
  const rotated = { keyId: 'new', key: randomBytes(32), previous: new Map([['old', keys.key]]) };
  assert.equal(decryptInvitationCopy(workspace, invitation, encrypted, rotated), token);
  assert.throws(
    () => decryptInvitationCopy(workspace, invitation, encrypted, { ...rotated, previous: new Map() }),
    /Invitation copy unavailable/,
  );
});
