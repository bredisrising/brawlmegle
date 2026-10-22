import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// config.ts reads window.location at import; roster.ts keeps owner keys and claims in localStorage.
const store = new Map<string, string>();
vi.stubGlobal('window', { location: { search: '' } });
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
});
vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
let roster: typeof import('../../src/forge/roster');
beforeAll(async () => {
  roster = await import('../../src/forge/roster');
});
beforeEach(() => store.clear());

describe('whose fighter it is', () => {
  it("plays someone else's fighter as a guest, and your own (or a house fighter) for real", () => {
    roster.saveOwner({ id: 'mine-1', key: 'k1' }, 'rico');
    expect(roster.isMine({ id: 'mine-1', username: 'rico' })).toBe(true);
    expect(roster.isMine({ id: 'theirs', username: 'dyl' })).toBe(false);
    expect(roster.isMine({ id: 'default' })).toBe(true); // no username: a house fighter or a bot
  });

  it('follows the username to a rescan made on another laptop', () => {
    roster.saveOwner({ id: 'old', key: 'k1' }, 'rico');
    expect(roster.ownerProof({ id: 'new-elsewhere', username: 'rico' })).toEqual({ id: 'old', key: 'k1' });
  });

  it('makes a fighter yours with its code, and forgets it when it is deleted', () => {
    expect(roster.isMine({ id: 'f1', username: 'phoenix' })).toBe(false);
    roster.saveClaim({ id: 'f1', code: 'ABCD-EFGH-JKMN-PQRS', username: 'phoenix', name: 'phoenix' });
    expect(roster.ownerProof({ id: 'f1', username: 'phoenix' })).toEqual({ id: 'f1', code: 'ABCD-EFGH-JKMN-PQRS' });
    expect(roster.ownerProof({ id: 'f2', username: 'phoenix' })).toEqual({ id: 'f1', code: 'ABCD-EFGH-JKMN-PQRS' });
    roster.forgetFighter('f1');
    expect(roster.isMine({ id: 'f1', username: 'phoenix' })).toBe(false);
  });

  it('prefers the owner key over a code for the same fighter', () => {
    roster.saveClaim({ id: 'f1', code: 'ABCD-EFGH-JKMN-PQRS', username: 'rico', name: 'rico' });
    roster.saveOwner({ id: 'f1', key: 'k1' }, 'rico');
    expect(roster.ownerProof({ id: 'f1', username: 'rico' })).toEqual({ id: 'f1', key: 'k1' });
  });
});
