import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emailDeliveryEnabled } from '../src/email-delivery-composition.ts';

test('production workers do not require email credentials or a queue when email is disabled', () => {
  assert.equal(emailDeliveryEnabled({ NODE_ENV: 'production' }), false);
  assert.equal(emailDeliveryEnabled({ NODE_ENV: 'production', EMAIL_DELIVERY_DATABASE_URL: 'unused' }), false);
});

test('production workers accept SMTP without ACS and still reject incomplete enabled transports', () => {
  const smtp = {
    NODE_ENV: 'production',
    EMAIL_PROVIDER: 'smtp',
    SMTP_HOST: 'smtp.example.com',
    SMTP_FROM_ADDRESS: 'noreply@example.com',
    SMTP_USER: 'test-user',
    SMTP_PASSWORD: 'test-password',
    EMAIL_DELIVERY_DATABASE_URL: 'postgresql://email:password@localhost/tulipfarm',
  };
  assert.equal(emailDeliveryEnabled(smtp), true);
  assert.throws(() => emailDeliveryEnabled({ ...smtp, EMAIL_DELIVERY_DATABASE_URL: '' }), /database configuration/);
  assert.throws(() => emailDeliveryEnabled({ ...smtp, SMTP_HOST: '' }), /SMTP_HOST/);
  assert.throws(() => emailDeliveryEnabled({ EMAIL_PROVIDER: 'invalid' }), /EMAIL_PROVIDER/);
});
