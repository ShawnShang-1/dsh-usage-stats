window.__ModuleLoader__.load({
	id: "dsh-usage-stats",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		//#region locale
		/** Dictionary namespace owned by this plugin. */
		const NS = "settings.usageStats";
		/** English copy. */
		const en = {
			nav: "Usage",
			title: "Token activity",
			daily: "Daily",
			weekly: "Weekly",
			cumulative: "Cumulative",
			totalTokens: "Total tokens",
			peakTokens: "Peak tokens",
			longestChat: "Longest chat",
			currentStreak: "Current streak",
			longestStreak: "Longest streak",
			models: "Model detail",
			model: "Model",
			input: "Input",
			output: "Output",
			cacheRead: "Cache read",
			cacheHit: "Cache hit rate",
			today: "Today",
			total: "Total",
			costToday: "Cost today",
			costTotal: "Total cost",
			noPrice: "No rate configured for this model.",
			empty: "No session usage recorded yet.",
			loading: "Tallying your sessions…",
			refreshing: "Refreshing…",
			retry: "Retry",
			refresh: "Refresh",
			failed: "The Host could not be reached.",
			sessions: "sessions",
			scanned: "scanned",
			updated: "Updated"
		};
		/** Simplified Chinese copy. */
		const zh = {
			nav: "使用统计",
			title: "Token 活动",
			daily: "每日",
			weekly: "每周",
			cumulative: "累计",
			totalTokens: "累计 Token 数",
			peakTokens: "峰值 Token 数",
			longestChat: "最长聊天时长",
			currentStreak: "当前连续天数",
			longestStreak: "最长连续天数",
			models: "模型明细",
			model: "模型",
			input: "输入",
			output: "输出",
			cacheRead: "缓存读取",
			cacheHit: "缓存命中率",
			today: "今日",
			total: "累计",
			costToday: "今日消费",
			costTotal: "累计消费",
			noPrice: "该模型没有配置单价。",
			empty: "还没有可统计的会话数据。",
			loading: "正在统计会话…",
			refreshing: "正在刷新…",
			retry: "重试",
			refresh: "刷新",
			failed: "无法连接到 Host。",
			sessions: "个会话",
			scanned: "已扫描",
			updated: "更新于"
		};
		//#endregion
		//#region tokens
		const T = {
			label: "var(--dsw-alias-label-primary)",
			label2: "var(--dsw-alias-label-secondary)",
			border: "var(--dsw-alias-border-l1)",
			surface: "var(--dsw-alias-bg-layer-1)",
			surface2: "var(--dsw-alias-bg-layer-2)",
			hover: "var(--dsw-alias-interactive-bg-hover)",
			active: "var(--dsw-alias-interactive-bg-active)",
			accent: "var(--dsw-static-blue-500)",
			stroke: "var(--dsw-alias-settings-card-stroke)",
			tertiary: "var(--dsw-alias-label-tertiary)",
			error: "var(--dsw-alias-state-error-primary)",
			radius: "var(--dsw-radius-md)",
			radiusSm: "var(--dsw-radius-sm)"
		};
		const cardStyle = {
			border: `1px solid ${T.stroke}`,
			borderRadius: "var(--dsw-radius-panel)",
			background: T.hover,
			display: "flex",
			overflow: "hidden"
		};
		const sectionTitle = {
			color: T.label,
			fontSize: 14,
			fontWeight: 500,
			lineHeight: "22px",
			margin: 0
		};
		const th = {
			color: T.label2,
			fontSize: 12,
			fontWeight: 400,
			lineHeight: "18px",
			textAlign: "right",
			padding: "0 0 6px 12px",
			whiteSpace: "nowrap"
		};
		const thFirst = Object.assign({}, th, { textAlign: "left", paddingLeft: 0 });
		const td = {
			color: T.label,
			fontSize: 13,
			lineHeight: "20px",
			textAlign: "right",
			padding: "7px 0 7px 12px",
			whiteSpace: "nowrap",
			fontVariantNumeric: "tabular-nums"
		};
		const tdFirst = Object.assign({}, td, { textAlign: "left", paddingLeft: 0 });
		//#endregion
		//#region format
		/**
		* Language id the panel formats numbers and durations in.
		* @param ctx - the client plugin context.
		* @returns `zh` or `en`.
		*/
		function languageOf(ctx) {
			try {
				const snapshot = ctx.locale.getSnapshot();
				return typeof snapshot?.active === "string" && snapshot.active.startsWith("zh") ? "zh" : "en";
			} catch {
				return "en";
			}
		}
		/** Compact token counts: `4.2亿` in Chinese, `420M` in English. */
		function compact(value, lang) {
			if (typeof value !== "number" || !Number.isFinite(value)) return "—";
			if (value === 0) return "0";
			return new Intl.NumberFormat(lang === "zh" ? "zh-CN" : "en-US", {
				notation: "compact",
				maximumFractionDigits: 1
			}).format(value);
		}
		/** Full counts with grouping separators. */
		function full(value, lang) {
			if (typeof value !== "number" || !Number.isFinite(value)) return "—";
			return new Intl.NumberFormat(lang === "zh" ? "zh-CN" : "en-US").format(value);
		}
		/**
		* `30.7 小时` / `47 分` — one decimal, so the figure fits one headline cell.
		* @param ms - a session span in milliseconds.
		* @param lang - the number language.
		* @returns the display text.
		*/
		function duration(ms, lang) {
			const minutes = Math.max(0, Math.round((ms ?? 0) / 60000));
			if (minutes < 60) return lang === "zh" ? `${minutes} 分` : `${minutes} m`;
			return lang === "zh" ? `${(minutes / 60).toFixed(1)} 小时` : `${(minutes / 60).toFixed(1)} h`;
		}
		/** `9 天` / `9 days`. */
		function daysLabel(count, lang) {
			return lang === "zh" ? `${count} 天` : `${count} ${count === 1 ? "day" : "days"}`;
		}
		/** `98.5%`. */
		function percent(ratio) {
			if (typeof ratio !== "number" || !Number.isFinite(ratio)) return "—";
			const value = ratio * 100;
			return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)}%`;
		}
		/** `HH:MM` of one epoch millisecond. */
		function clockOf(ms) {
			const date = new Date(ms);
			return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
		}
		//#endregion
		//#region store
		/**
		* Create the panel's one snapshot store: the aggregate payload, the load
		* state, and the selected heatmap aggregation.
		* @returns the store face the component reads.
		*/
		function createStore() {
			let snapshot = { status: "idle", data: null, error: null, mode: "daily", costMode: "total" };
			const listeners = new Set();
			return {
				getSnapshot: () => snapshot,
				subscribe(listener) {
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				},
				patch(next) {
					snapshot = Object.assign({}, snapshot, next);
					for (const listener of [...listeners]) listener();
				}
			};
		}
		//#endregion
		//#region heatmap
		const DAY_MS = 86400000;
		const MONTH_ZH = ["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"];
		const MONTH_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
		/**
		* Parse a `YYYY-MM-DD` key into its calendar parts.
		* @param key - a day key from the Host payload.
		* @returns `{year, month, day}`.
		*/
		function partsOf(key) {
			const [year, month, day] = key.split("-").map(Number);
			return { year, month, day };
		}
		/**
		* Weekday index (Sunday = 0) of one day key.
		* @param key - a day key.
		* @returns 0..6.
		*/
		function weekdayOf(key) {
			const { year, month, day } = partsOf(key);
			return new Date(year, month - 1, day).getDay();
		}
		/**
		* Monday-based week index of one day key, for week aggregation.
		* @param key - a day key.
		* @returns an integer equal for every day of one Monday-started week.
		*/
		function weekIndexOf(key) {
			const { year, month, day } = partsOf(key);
			const utc = Date.UTC(year, month - 1, day) / DAY_MS;
			const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
			const mondayOffset = (weekday + 6) % 7;
			return Math.floor((utc - mondayOffset) / 7);
		}
		/**
		* Turn the payload's day rows into the values the three aggregations shade.
		* @param days - ascending day rows from the Host payload.
		* @param mode - `daily`, `weekly`, or `cumulative`.
		* @returns one value per day index, in the same order as `days`.
		*/
		function valuesFor(days, mode) {
			if (mode === "weekly") {
				const weeks = new Map();
				for (const day of days) {
					const week = weekIndexOf(day.date);
					weeks.set(week, (weeks.get(week) ?? 0) + day.totalTokens);
				}
				return days.map((day) => weeks.get(weekIndexOf(day.date)) ?? 0);
			}
			if (mode === "cumulative") {
				let running = 0;
				return days.map((day) => {
					running += day.totalTokens;
					return running;
				});
			}
			return days.map((day) => day.totalTokens);
		}
		/**
		* Tooltip noun for the selected aggregation.
		* @param mode - the aggregation.
		* @param t - the page's translator.
		* @returns the noun.
		*/
		function labelFor(mode, t) {
			return mode === "weekly" ? t("weekly") : mode === "cumulative" ? t("cumulative") : t("daily");
		}
		/**
		* Measure an element's content width, so the heatmap fits the panel.
		* @returns `[ref, width]`.
		*/
		function useWidth() {
			const ref = react.useRef(null);
			const [width, setWidth] = react.useState(0);
			react.useEffect(() => {
				const element = ref.current;
				if (element === null) return;
				const update = () => setWidth(element.clientWidth);
				update();
				if (typeof ResizeObserver === "undefined") return;
				const observer = new ResizeObserver(update);
				observer.observe(element);
				return () => observer.disconnect();
			}, []);
			return [ref, width];
		}
		/**
		* The contribution-style activity grid over the payload's window.
		* @returns the grid element tree.
		*/
		function Heatmap(props) {
			const { days, mode, lang, t } = props;
			const [ref, width] = useWidth();
			const values = react.useMemo(() => valuesFor(days, mode), [days, mode]);
			const peak = react.useMemo(() => values.reduce((max, value) => (value > max ? value : max), 0), [values]);

			const offset = days.length > 0 ? weekdayOf(days[0].date) : 0;
			const columns = Math.max(1, Math.ceil((offset + days.length) / 7));
			// A year of columns needs a tighter gutter to stay inside the panel.
			const gap = columns > 30 ? 2 : 3;
			const cell = width > 0
				? Math.max(5, Math.min(13, Math.floor((width - gap * (columns - 1)) / columns)))
				: 10;
			const step = cell + gap;

			const shade = (value) => {
				if (value <= 0 || peak <= 0) return {};
				const ratio = value / peak;
				// Six steps rather than four, so a busy stretch separates its
				// ordinary days instead of collapsing them into one shade.
				const alpha = ratio >= 5 / 6 ? 1
					: ratio >= 4 / 6 ? 0.84
						: ratio >= 3 / 6 ? 0.68
							: ratio >= 2 / 6 ? 0.5
								: ratio >= 1 / 6 ? 0.32
									: 0.18;
				return { background: `color-mix(in srgb, ${T.accent} ${Math.round(alpha * 100)}%, transparent)` };
			};

			const cells = [];
			const monthLabels = [];
			let previousMonth = -1;
			for (let column = 0; column < columns; column += 1) {
				const children = [];
				for (let row = 0; row < 7; row += 1) {
					const index = column * 7 + row - offset;
					const inRange = index >= 0 && index < days.length;
					const day = inRange ? days[index] : undefined;
					const value = inRange ? values[index] : 0;
					const isToday = inRange && index === days.length - 1;
					children.push(react.createElement("div", {
						key: row,
						title: day === undefined ? undefined : `${day.date} · ${compact(value, lang)} · ${labelFor(mode, t)}`,
						style: Object.assign({
							width: cell,
							height: cell,
							borderRadius: 2,
							border: `1px solid ${T.border}`,
							boxSizing: "border-box",
							background: day === undefined ? "transparent" : T.hover
						}, day === undefined ? {} : shade(value), isToday ? { outline: `1px solid ${T.tertiary}`, outlineOffset: 1 } : {})
					}));
				}
				cells.push(react.createElement("div", {
					key: column,
					style: { display: "flex", flexDirection: "column", gap }
				}, children));

				const middle = column * 7 + 3 - offset;
				if (middle >= 0 && middle < days.length) {
					const { month } = partsOf(days[middle].date);
					if (month !== previousMonth) {
						previousMonth = month;
						monthLabels.push({ column, label: lang === "zh" ? MONTH_ZH[month - 1] : MONTH_EN[month - 1] });
					}
				}
			}

			return react.createElement("div", { ref, style: { width: "100%" } }, [
				react.createElement("div", { key: "grid", style: { display: "flex", gap } }, cells),
				react.createElement("div", {
					key: "months",
					style: { position: "relative", height: 18, marginTop: 6 }
				}, monthLabels.map((entry) => react.createElement("span", {
					key: entry.column,
					style: {
						position: "absolute",
						left: entry.column * step,
						color: T.label2,
						fontSize: 12,
						lineHeight: "18px",
						whiteSpace: "nowrap"
					}
				}, entry.label)))
			]);
		}
		//#endregion
		//#region pieces
		/**
		* Display width of one headline value, counting a CJK glyph as two Latin ones.
		* @param value - the rendered text.
		* @returns the comparable width in Latin-glyph units.
		*/
		function glyphWidth(value) {
			return [...String(value ?? "")].reduce((sum, character) => sum + (/[\u2e80-\u9fff\uff00-\uffef]/.test(character) ? 2 : 1), 0);
		}
		/**
		* Font size that keeps one headline value inside its cell. The settings panel
		* is 800px wide with a 188px rail, so each of the five cells gets ~96px of
		* text; a step-down is cheaper than an ellipsis for `9999.9万` or `30.7 小时`.
		* @param value - the rendered text.
		* @returns a font size in pixels.
		*/
		function fitFontSize(value) {
			const width = glyphWidth(value);
			if (width >= 9) return 16;
			if (width >= 7) return 18;
			return 21;
		}
		/**
		* One headline figure.
		* @returns the cell element tree.
		*/
		function StatCell(props) {
			return react.createElement("div", {
				style: {
					flex: "1 1 0",
					minWidth: 0,
					padding: "14px 8px",
					textAlign: "center"
				}
			}, [
				react.createElement("div", {
					key: "value",
					style: {
						color: T.label,
						fontSize: fitFontSize(props.value),
						fontWeight: 600,
						lineHeight: "28px",
						letterSpacing: "-0.02em",
						whiteSpace: "nowrap",
						overflow: "hidden",
						textOverflow: "ellipsis"
					}
				}, props.value),
				react.createElement("div", {
					key: "label",
					style: { color: T.label2, fontSize: 12, lineHeight: "18px", marginTop: 2 }
				}, props.label),
				props.hint === undefined ? null : react.createElement("div", {
					key: "hint",
					style: { color: T.label2, fontSize: 11, lineHeight: "16px", opacity: 0.8 }
				}, props.hint)
			]);
		}
		/**
		* The headline figures in one bordered strip.
		* @returns the strip element tree.
		*/
		function Summary(props) {
			const { data, lang, t } = props;
			const cells = [
				{ key: "total", value: compact(data.totals.totalTokens, lang), label: t("totalTokens") },
				{
					key: "peak",
					value: compact(data.peakAllTime?.totalTokens ?? 0, lang),
					label: t("peakTokens"),
					hint: data.peakAllTime === null ? undefined : data.peakAllTime.date
				},
				{ key: "duration", value: duration(data.longestSession?.durationMs ?? 0, lang), label: t("longestChat") },
				{ key: "current", value: daysLabel(data.currentStreakDays, lang), label: t("currentStreak") },
				{ key: "longest", value: daysLabel(data.longestStreakDays, lang), label: t("longestStreak") }
			];
			const children = [];
			cells.forEach((cell, index) => {
				if (index > 0) children.push(react.createElement("div", {
					key: `${cell.key}-divider`,
					style: { width: 1, background: T.border, margin: "12px 0" }
				}));
				children.push(react.createElement(StatCell, Object.assign({ key: cell.key }, cell)));
			});
			return react.createElement("div", { style: cardStyle }, children);
		}
		/**
		* One segmented control.
		* @returns the control element tree.
		*/
		function Segmented(props) {
			return react.createElement("div", {
				style: {
					display: "inline-flex",
					alignItems: "center",
					gap: 2,
					padding: 2,
					borderRadius: T.radius,
					border: `1px solid ${T.border}`,
					background: "transparent"
				}
			}, props.options.map((option) => react.createElement("button", {
				key: option.id,
				type: "button",
				onClick: () => props.onChange(option.id),
				style: {
					cursor: "pointer",
					border: "none",
					borderRadius: T.radiusSm,
					padding: "3px 10px",
					font: "inherit",
					fontSize: 12,
					lineHeight: "18px",
					color: props.value === option.id ? T.label : T.label2,
					fontWeight: props.value === option.id ? 500 : 400,
					background: props.value === option.id ? T.active : "transparent"
				}
			}, option.label)));
		}
		/**
		* The per-model token and cache detail.
		* @returns the table element tree.
		*/
		function ModelTable(props) {
			const { data, lang, costMode, t } = props;
			const rows = data.models;
			if (rows.length === 0) {
				return react.createElement("div", { style: { color: T.label2, fontSize: 13, padding: "8px 0" } }, t("empty"));
			}
			const currency = data.pricing?.currency ?? "";
			const costLabel = costMode === "today" ? t("costToday") : t("costTotal");
			/** `12.3` — no currency symbol, always exactly one decimal. */
			const money = (row) => {
				const value = row.cost === null || row.cost === undefined ? undefined : row.cost[costMode === "today" ? "today" : "total"];
				if (value === undefined) return "—";
				if (value > 0 && value < 0.1) return "<0.1";
				return value.toFixed(1);
			};
			return react.createElement("table", {
				style: { width: "100%", borderCollapse: "collapse", tableLayout: "auto" }
			}, [
				react.createElement("thead", { key: "head" }, react.createElement("tr", null, [
					react.createElement("th", { key: "model", style: thFirst }, t("model")),
					react.createElement("th", { key: "total", style: th }, t("totalTokens")),
					react.createElement("th", { key: "input", style: th }, t("input")),
					react.createElement("th", { key: "output", style: th }, t("output")),
					react.createElement("th", { key: "cache", style: th }, t("cacheRead")),
					react.createElement("th", { key: "hit", style: th }, t("cacheHit")),
					react.createElement("th", {
						key: "cost",
						style: Object.assign({}, th, { paddingLeft: 14, color: T.label }),
						title: data.pricing?.configured === false ? t("noPrice") : undefined
					}, costLabel)
				])),
				react.createElement("tbody", { key: "body" }, rows.map((row) => react.createElement("tr", {
					key: row.key,
					style: { borderTop: `1px solid ${T.border}` }
				}, [
					react.createElement("td", { key: "model", style: tdFirst }, row.model),
					react.createElement("td", {
						key: "total",
						style: Object.assign({}, td, { fontWeight: 600 }),
						title: full(row.totalTokens, lang)
					}, compact(row.totalTokens, lang)),
					react.createElement("td", {
						key: "input",
						style: td,
						title: full(row.inputTokens, lang)
					}, compact(row.inputTokens, lang)),
					react.createElement("td", {
						key: "output",
						style: td,
						title: full(row.outputTokens, lang)
					}, compact(row.outputTokens, lang)),
					react.createElement("td", {
						key: "cache",
						style: td,
						title: full(row.cacheReadTokens, lang)
					}, compact(row.cacheReadTokens, lang)),
					react.createElement("td", { key: "hit", style: td }, [
						react.createElement("div", { key: "value" }, percent(row.cacheHitRate)),
						react.createElement("div", {
							key: "bar",
							style: {
								marginTop: 4,
								height: 3,
								borderRadius: 2,
								background: T.hover,
								overflow: "hidden"
							}
						}, react.createElement("div", {
							style: {
								width: `${Math.max(0, Math.min(1, row.cacheHitRate)) * 100}%`,
								height: "100%",
								background: T.accent
							}
						}))
					]),
					react.createElement("td", {
						key: "cost",
						style: Object.assign({}, td, { paddingLeft: 14, fontWeight: 600, fontVariantNumeric: "tabular-nums" }),
						title: row.cost === null || row.cost === undefined ? t("noPrice") : `${currency}${row.cost[costMode === "today" ? "today" : "total"]}`
					}, money(row))
				])))
			]);
		}
		/**
		* A quiet text button.
		* @returns the button element tree.
		*/
		function TextButton(props) {
			const [hover, setHover] = react.useState(false);
			return react.createElement("button", {
				type: "button",
				onClick: props.onClick,
				disabled: props.disabled === true,
				onMouseEnter: () => setHover(true),
				onMouseLeave: () => setHover(false),
				style: {
					cursor: props.disabled === true ? "default" : "pointer",
					border: "none",
					borderRadius: T.radiusSm,
					padding: "4px 10px",
					font: "inherit",
					fontSize: 12,
					lineHeight: "18px",
					color: props.disabled === true ? T.label2 : T.label,
					background: hover && props.disabled !== true ? T.hover : "transparent"
				}
			}, props.children);
		}
		//#endregion
		//#region plugin
		/** Required services (cordis fiber inject). */
		const inject = ["slots", "locale"];

		/**
		* Register the usage page into the settings shell.
		* @param ctx - the browser plugin context.
		* @returns {void}
		*/
		function apply(ctx) {
			const store = createStore();
			const t = ctx.locale.bind(NS);
			let loaded = false;
			let loading = false;
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "usage-stats: dictionaries");

			const load = (refresh) => {
				if (loading) return;
				loading = true;
				const current = store.getSnapshot();
				store.patch({
					status: current.data === null ? "loading" : "refreshing",
					error: null
				});
				Promise.resolve()
					.then(() => fetch(`/dsh-usage-stats/${refresh === true ? "refresh" : "overview"}`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: "{}"
					}))
					.then((response) => {
						if (!response.ok) throw new Error(`HTTP ${response.status}`);
						return response.json();
					})
					.then((payload) => {
						if (payload === null || typeof payload !== "object" || payload.ok !== true) {
							throw new Error(payload?.error ?? "the Host returned no summary");
						}
						store.patch({ status: "ready", data: payload.value, error: null });
					}, (error) => {
						store.patch({ status: "error", error: error instanceof Error ? error.message : String(error) });
					})
					.then(() => {
						loading = false;
					});
			};

			/**
			* The Settings page itself.
			* @param props - composed slot props, carrying the shell's `t`.
			* @returns the page element tree.
			*/
			function UsageSection(props) {
				const tr = typeof props.t === "function" ? props.t : t;
				const state = react.useSyncExternalStore(store.subscribe, store.getSnapshot);
				react.useEffect(() => {
					if (!loaded) {
						loaded = true;
						load(false);
					}
				}, []);
				const lang = languageOf(ctx);
				const data = state.data;
				const busy = state.status === "loading" || state.status === "refreshing";

				const header = react.createElement("div", {
					key: "header",
					style: {
						display: "flex",
						alignItems: "center",
						justifyContent: "space-between",
						gap: 12,
						marginBottom: 10
					}
				}, [
					react.createElement("h3", { key: "title", style: sectionTitle }, tr("title")),
					react.createElement("div", { key: "actions", style: { display: "flex", alignItems: "center", gap: 8 } }, [
						data === null ? null : react.createElement(Segmented, {
							key: "mode",
							value: state.mode,
							onChange: (mode) => store.patch({ mode }),
							options: [
								{ id: "daily", label: tr("daily") },
								{ id: "weekly", label: tr("weekly") },
								{ id: "cumulative", label: tr("cumulative") }
							]
						}),
						react.createElement(TextButton, {
							key: "refresh",
							disabled: busy,
							onClick: () => load(true)
						}, busy ? tr("refreshing") : tr("refresh"))
					])
				]);

				const body = [];
				body.push(header);

				if (data === null && state.status === "loading") {
					body.push(react.createElement("div", {
						key: "loading",
						style: { color: T.label2, fontSize: 13, padding: "16px 0" }
					}, tr("loading")));
				}
				if (state.status === "error") {
					body.push(react.createElement("div", {
						key: "error",
						style: {
							border: `1px solid ${T.border}`,
							borderRadius: T.radius,
							padding: "12px 14px",
							color: T.error,
							fontSize: 13,
							display: "flex",
							alignItems: "center",
							gap: 12
						}
					}, [
						react.createElement("span", { key: "text" }, `${tr("failed")} ${state.error ?? ""}`),
						react.createElement(TextButton, { key: "retry", onClick: () => load(true) }, tr("retry"))
					]));
				}

				if (data !== null) {
					body.push(react.createElement(Summary, { key: "summary", data, lang, t: tr }));
					body.push(react.createElement(Heatmap, {
						key: "heatmap",
						days: data.days,
						mode: state.mode,
						lang,
						t: tr
					}));
					body.push(react.createElement("div", {
						key: "models-header",
						style: {
							display: "flex",
							alignItems: "center",
							justifyContent: "space-between",
							gap: 12,
							marginTop: 10,
							marginBottom: 4
						}
					}, [
						react.createElement("h3", { key: "title", style: sectionTitle }, tr("models")),
						react.createElement(Segmented, {
							key: "cost-mode",
							value: state.costMode,
							onChange: (costMode) => store.patch({ costMode }),
							options: [
								{ id: "today", label: tr("today") },
								{ id: "total", label: tr("total") }
							]
						})
					]));
					body.push(react.createElement(ModelTable, {
						key: "models",
						data,
						lang,
						costMode: state.costMode,
						t: tr
					}));
					body.push(react.createElement("div", {
						key: "footnote",
						style: { color: T.label2, fontSize: 11, lineHeight: "16px", marginTop: 10 }
					}, `${tr("scanned")} ${data.scan?.sessions ?? 0}/${data.scan?.total ?? 0} ${tr("sessions")}` +
						(data.scan?.failed ? ` · ${data.scan.failed} failed` : "") +
						` · ${tr("updated")} ${clockOf(data.generatedAt)}`));
				}

				return react.createElement("div", {
					style: { display: "flex", flexDirection: "column", gap: 16, paddingTop: 6, paddingBottom: 24 }
				}, body);
			}

			ctx.effect(() => ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "usage",
				order: 13,
				label: () => t("nav"),
				locale: NS
			}, UsageSection)), "usage-stats: settings section");
		}
		//#endregion
		exports.NS = NS;
		exports.apply = apply;
		exports.inject = inject;
		/** Pure pieces, exported so `scripts/check-ui.mjs` renders them without a browser. */
		exports.__internals = {
			Summary,
			ModelTable,
			Heatmap,
			Segmented,
			TextButton,
			valuesFor,
			weekdayOf,
			weekIndexOf,
			createStore,
			compact,
			full,
			duration,
			percent
		};
		return module.exports;
	}
});
