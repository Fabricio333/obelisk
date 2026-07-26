import { describe, expect, it } from 'vitest';
import { operatorPubkeyFromRelayInfo } from './relay-info';

const SERVICE_KEY = 'a'.repeat(64);
const CONTACT_NPUB = 'npub1m9vsm9d8sy0pevcjhenwm4ny6l37dm2hsg4dnusna43ql3n5305qy4zlg4';

describe('operatorPubkeyFromRelayInfo', () => {
  it('prefers a valid human operator contact over the relay service key', () => {
    expect(operatorPubkeyFromRelayInfo({
      pubkey: SERVICE_KEY,
      contact: CONTACT_NPUB,
      fetchedAt: 0,
    })).toBe('d9590d95a7811e1cb312be66edd664d7e3e6ed57822ad9f213ed620fc6748be8');
  });

  it('falls back to the service key when contact is not a valid npub', () => {
    expect(operatorPubkeyFromRelayInfo({
      pubkey: SERVICE_KEY,
      contact: 'ops@example.com',
      fetchedAt: 0,
    })).toBe(SERVICE_KEY);
  });

  it('returns null without a usable operator identity', () => {
    expect(operatorPubkeyFromRelayInfo(null)).toBeNull();
  });
});
