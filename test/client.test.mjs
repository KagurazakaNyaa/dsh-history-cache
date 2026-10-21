import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Minimal browser harness: capture the module the Client bundle registers, and
 * emulate the slices of the Session Controller the cache depends on.
 */
const registry = new Map();
const storage = new Map();

globalThis.window = {
	__ModuleLoader__: {
		load({ id, factory }) {
			registry.set(id, factory(() => ({})));
		},
	},
	localStorage: {
		getItem(key) {
			return storage.has(key) ? storage.get(key) : null;
		},
		setItem(key, value) {
			storage.set(key, String(value));
		},
		removeItem(key) {
			storage.delete(key);
		},
	},
};

await import('../client.js');

const PACKAGE_ID = '@kagurazakanyaa/dsh-history-cache';
const plugin = registry.get(PACKAGE_ID);
assert.ok(plugin, 'client bundle must register the package id');
assert.deepEqual(plugin.inject, ['sessions']);

/**
 * Emulates reference counting, catalog rows, running state, and the list store.
 */
function makeSessions() {
	const listeners = new Set();
	const retained = new Map();
	const retainCalls = [];
	const releases = [];
	let snapshot = { ids: [], byId: {}, phase: 'ready' };

	const publish = () => {
		const byId = {};
		for (const [id, entry] of retained) {
			const retainedBy = {};
			if (entry.mainView > 0) retainedBy.mainView = entry.mainView;
			if (entry.historyCache > 0) retainedBy.historyCache = entry.historyCache;
			byId[id] = { id, retainedBy, running: entry.running };
		}
		snapshot = { ids: [...retained.keys()], byId, phase: 'ready' };
		for (const listener of [...listeners]) listener();
	};

	const ensure = id => {
		let entry = retained.get(id);
		if (entry === undefined) {
			entry = { mainView: 0, historyCache: 0, running: false };
			retained.set(id, entry);
		}
		return entry;
	};

	const sessions = {
		list: {
			getSnapshot: () => snapshot,
			subscribe(listener) {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
		},
		retain(id, options) {
			retainCalls.push({ id, source: options.source });
			const entry = retained.get(id);
			if (entry === undefined) throw new Error(`sessions.retain: unknown session ${id}`);
			entry[options.source] = (entry[options.source] ?? 0) + 1;
			publish();
			let released = false;
			return {
				release() {
					if (released) return;
					released = true;
					releases.push(id);
					entry[options.source] -= 1;
					publish();
				},
			};
		},
		add(id, { running = false } = {}) {
			ensure(id).running = running;
			publish();
		},
		select(id) {
			ensure(id).mainView += 1;
			publish();
		},
		unselect(id) {
			ensure(id).mainView -= 1;
			publish();
		},
		setRunning(id, running) {
			ensure(id).running = running;
			publish();
		},
		remove(id) {
			retained.delete(id);
			publish();
		},
		entry: id => retained.get(id),
		retainCalls,
		releases,
		listenerCount: () => listeners.size,
	};
	return sessions;
}

function makeCtx(sessions) {
	const disposers = [];
	return {
		sessions,
		effect(setup) {
			const dispose = setup();
			disposers.push(dispose);
			return dispose;
		},
		dispose() {
			for (const dispose of disposers.splice(0)) dispose?.();
		},
	};
}

function boot(sessions) {
	const ctx = makeCtx(sessions);
	plugin.apply(ctx);
	return ctx;
}

const warmCalls = sessions => sessions.retainCalls.filter(call => call.source === 'historyCache');

test('selecting an idle session pins its window', () => {
	const sessions = makeSessions();
	const ctx = boot(sessions);
	sessions.add('a');
	sessions.select('a');
	assert.deepEqual(warmCalls(sessions).map(call => call.id), ['a']);
	ctx.dispose();
});

test('switching away keeps the window and switching back reuses it', () => {
	const sessions = makeSessions();
	const ctx = boot(sessions);
	sessions.add('a');
	sessions.add('b');
	sessions.select('a');
	sessions.unselect('a');
	sessions.select('b');
	// The previous session must survive its mainView release.
	assert.equal(sessions.entry('a').historyCache, 1);
	assert.equal(warmCalls(sessions).filter(call => call.id === 'a').length, 1);
	assert.equal(warmCalls(sessions).filter(call => call.id === 'b').length, 1);
	// Coming back must not retain (or refetch) again.
	sessions.select('a');
	assert.equal(warmCalls(sessions).filter(call => call.id === 'a').length, 1);
	ctx.dispose();
});

test('a session with a running agent is never pinned', () => {
	const sessions = makeSessions();
	const ctx = boot(sessions);
	sessions.add('a', { running: true });
	sessions.select('a');
	assert.deepEqual(warmCalls(sessions), []);
	ctx.dispose();
});

test('a warm session that starts a background turn is released', () => {
	const sessions = makeSessions();
	const ctx = boot(sessions);
	sessions.add('a');
	sessions.select('a');
	sessions.unselect('a');
	assert.equal(sessions.entry('a').historyCache, 1);
	sessions.setRunning('a', true);
	assert.equal(sessions.entry('a').historyCache, 0);
	ctx.dispose();
});

test('the LRU cap evicts the oldest untouched sessions', () => {
	const sessions = makeSessions();
	const ctx = boot(sessions);
	const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
	for (const id of ids) sessions.add(id);
	for (const id of ids) {
		sessions.select(id);
		sessions.unselect(id);
	}
	const pinned = ids.filter(id => (sessions.entry(id).historyCache ?? 0) > 0);
	assert.equal(pinned.length, 6);
	assert.deepEqual(pinned, ['c', 'd', 'e', 'f', 'g', 'h']);
	ctx.dispose();
});

test('a session leaving the catalog is released', () => {
	const sessions = makeSessions();
	const ctx = boot(sessions);
	sessions.add('a');
	sessions.select('a');
	sessions.unselect('a');
	sessions.remove('a');
	assert.deepEqual(sessions.releases, ['a']);
	ctx.dispose();
});

test('disposing the plugin releases every warm window and unsubscribes', () => {
	const sessions = makeSessions();
	const ctx = boot(sessions);
	sessions.add('a');
	sessions.add('b');
	sessions.select('a');
	sessions.select('b');
	assert.equal(sessions.listenerCount(), 1);
	ctx.dispose();
	assert.equal(sessions.listenerCount(), 0);
	assert.deepEqual(sessions.releases.sort(), ['a', 'b']);
	assert.equal(warmCalls(sessions).every(call => call.source === 'historyCache'), true);
});

test('the disabled preference keeps the plugin inert', () => {
	storage.set('dsh-history-cache:disabled', 'true');
	const sessions = makeSessions();
	const ctx = boot(sessions);
	sessions.add('a');
	sessions.select('a');
	assert.deepEqual(warmCalls(sessions), []);
	assert.equal(sessions.listenerCount(), 0);
	ctx.dispose();
	storage.delete('dsh-history-cache:disabled');
});

test('a max of zero behaves like the plugin being off', () => {
	storage.set('dsh-history-cache:max', '0');
	const sessions = makeSessions();
	const ctx = boot(sessions);
	sessions.add('a');
	sessions.select('a');
	sessions.unselect('a');
	assert.deepEqual(warmCalls(sessions).map(call => call.id), ['a']);
	assert.equal(sessions.releases.includes('a'), true);
	storage.delete('dsh-history-cache:max');
	ctx.dispose();
});
