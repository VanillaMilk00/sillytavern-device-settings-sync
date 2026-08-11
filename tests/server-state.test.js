import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState, mergeMutations, touchSettings } from '../server-plugin/state.js';

const DEVICE_A = 'device_aaaaaaaaaaaaaaaa';
const DEVICE_B = 'device_bbbbbbbbbbbbbbbb';

test('merges concurrent devices per key in server arrival order', () => {
    let state = createInitialState();
    state = mergeMutations(state, {
        deviceId: DEVICE_A,
        mutations: [{ key: 'shared', value: 'A' }, { key: 'only-a', value: '1' }],
    }, '2026-08-08T00:00:00.000Z');
    state = mergeMutations(state, {
        deviceId: DEVICE_B,
        mutations: [{ key: 'shared', value: 'B' }],
    }, '2026-08-08T00:00:01.000Z');
    assert.equal(state.entries.shared.value, 'B');
    assert.equal(state.entries['only-a'].value, '1');
    assert.equal(state.revision, 3);
});

test('keeps deletions as tombstones for offline devices', () => {
    let state = mergeMutations(createInitialState(), {
        deviceId: DEVICE_A,
        mutations: [{ key: 'removed', value: 'before' }],
    });
    state = mergeMutations(state, {
        deviceId: DEVICE_B,
        mutations: [{ key: 'removed', deleted: true }],
    });
    assert.equal(state.entries.removed.deleted, true);
    assert.equal(state.entries.removed.value, undefined);
});

test('account settings notifications advance the shared epoch', () => {
    const state = touchSettings(createInitialState(), {
        deviceId: DEVICE_A,
        changeId: 'change_aaaaaaaaaaaaaaaa',
    });
    assert.equal(state.settingsEpoch, 1);
    assert.equal(state.settingsDeviceId, DEVICE_A);
});

test('marks the first complete browser snapshot as seeded', () => {
    const state = mergeMutations(createInitialState(), {
        deviceId: DEVICE_A,
        seed: true,
        mutations: [{ key: 'portable-setting', value: 'ready' }],
    });
    assert.equal(state.seeded, true);
    assert.equal(state.revision, 2);
});
