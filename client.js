window.__ModuleLoader__.load({
	id: '@kagurazakanyaa/dsh-history-cache',
	factory: (require) => {
		/**
		 * Client half of the history cache.
		 *
		 * The Session Controller shares one `Session` instance per retained
		 * session and tears it down (closing its event stream and dropping its
		 * loaded window) when the last reference is released. The main view
		 * releases its reference on every session switch, so switching back
		 * re-opens history from the Host.
		 *
		 * This module keeps its own `historyCache` reference on sessions the
		 * user has viewed, bounded by an LRU cap. A switch back then retains an
		 * already-open window: no `session.follow` history page is requested.
		 * Sessions with a running agent are deliberately not pinned, so their
		 * token stream is not consumed in the background.
		 */
		const DEFAULT_MAX_WARM = 6;
		const PREF_MAX = 'dsh-history-cache:max';
		const PREF_DISABLED = 'dsh-history-cache:disabled';

		function readPreference(key) {
			try {
				return window.localStorage.getItem(key);
			} catch {
				return null;
			}
		}

		function readMaxWarm() {
			const raw = readPreference(PREF_MAX);
			if (raw === null) return DEFAULT_MAX_WARM;
			const parsed = Number(raw);
			return Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_MAX_WARM;
		}

		return {
			inject: ['sessions'],
			apply(ctx) {
				const sessions = ctx.sessions;
				if (sessions === undefined || readPreference(PREF_DISABLED) === 'true') return;
				const maxWarm = readMaxWarm();
				console.info(`[dsh-history-cache] warm session cache enabled (max ${maxWarm})`);
				/** id -> live reference, in least-recently-used order (first is oldest). */
				const warm = new Map();
				let visible = new Set();
				let reconciling = false;
				let disposed = false;

				function drop(id) {
					const reference = warm.get(id);
					if (reference === undefined) return;
					warm.delete(id);
					reference.release();
				}

				function warmSession(id) {
					if (disposed) return;
					const existing = warm.get(id);
					if (existing !== undefined) {
						warm.delete(id);
						warm.set(id, existing);
						return;
					}
					let reference;
					try {
						reference = sessions.retain(id, { source: 'historyCache' });
					} catch {
						// The identity may not be addressable yet; a later list update retries.
						return;
					}
					warm.set(id, reference);
				}

				function reconcile() {
					if (disposed || reconciling) return;
					reconciling = true;
					try {
						const state = sessions.list.getSnapshot();
						const byId = state !== null && typeof state === 'object' && state.byId !== null && typeof state.byId === 'object' ? state.byId : {};
						visible = new Set();
						for (const id of Object.keys(byId)) {
							const row = byId[id];
							const selected = (row.retainedBy?.mainView ?? 0) > 0;
							if (selected) {
								visible.add(id);
								if (!row.running) warmSession(id);
								else drop(id);
							} else if (row.running) {
								// A background turn streams live tokens; keeping it resident
								// would cost more network than the refetch it saves.
								drop(id);
							}
						}
						for (const id of [...warm.keys()]) if (byId[id] === undefined) drop(id);
						while (warm.size > maxWarm) {
							let victim;
							for (const id of warm.keys()) {
								if (!visible.has(id)) {
									victim = id;
									break;
								}
							}
							if (victim === undefined) break;
							drop(victim);
						}
					} finally {
						reconciling = false;
					}
				}

				ctx.effect(() => {
					const stop = sessions.list.subscribe(reconcile);
					reconcile();
					return () => {
						disposed = true;
						stop();
						for (const id of [...warm.keys()]) drop(id);
					};
				}, 'dsh-history-cache: warm session windows');
			},
		};
	},
});
