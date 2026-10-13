//! dsh-code-review client bundle — hand-written in the DSH client module
//! format (window.__ModuleLoader__.load). No build step: this file IS the
//! artifact referenced by package.json exports["./client"].
//!
//! Registers a page-type tab into the host right sidebar:
//!   1. the tab type into `ctx.sidebarRightTabs` (stage one), with a guide
//!      entry so the user can add it from the sidebar's guide page;
//!   2. the body into the keyed `sidebar.right.pane.tab` seat under the same
//!      id (stage two).
//! The right sidebar itself provides expand/collapse, docking and floating.
//!
//! TAB_ID keeps the historical "dsh-review-panel" spelling so sidebar tabs
//! already added under that type id keep working after the package rename.
window.__ModuleLoader__.load({
	id: "dsh-code-review",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var react = require("react");
		var h = react.createElement;

		var TAB_ID = "dsh-review-panel";
		var KIND = "review-panel";
		var POLL_MS = 4000;
		var MODEL_KEY = "dsh-code-review:model";

		var COLORS = {
			add: "#1a7f37",
			del: "#d1242f",
			hunk: "#8250df",
			addBg: "rgba(46,160,67,.12)",
			delBg: "rgba(248,81,73,.12)",
			hunkBg: "rgba(130,80,223,.08)",
			border: "rgba(128,128,128,.25)",
			hover: "rgba(128,128,128,.10)"
		};

		var STATUS_BADGES = {
			added: { label: "新增", color: COLORS.add },
			modified: { label: "修改", color: "#9a6700" },
			deleted: { label: "删除", color: COLORS.del },
			renamed: { label: "重命名", color: "#8250df" }
		};

		var styles = {
			root: {
				display: "flex",
				flexDirection: "column",
				height: "100%",
				overflow: "hidden",
				fontSize: "13px",
				fontFamily: "system-ui, sans-serif"
			},
			header: {
				padding: "10px 12px",
				borderBottom: "1px solid " + COLORS.border,
				flexShrink: 0
			},
			repoName: { fontWeight: 600, fontSize: "13px" },
			headerRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" },
			reviewButton: {
				fontSize: "12px",
				padding: "3px 10px",
				borderRadius: "6px",
				border: "1px solid " + COLORS.border,
				background: "transparent",
				color: "inherit",
				cursor: "pointer",
				flexShrink: 0
			},
			modelSelect: {
				fontSize: "11px",
				padding: "2px 4px",
				borderRadius: "6px",
				border: "1px solid " + COLORS.border,
				background: "transparent",
				color: "inherit",
				maxWidth: "160px",
				flexShrink: 1,
				minWidth: 0
			},
			headerMeta: { marginTop: "2px", fontSize: "11px", opacity: .6 },
			reviewBox: {
				flexShrink: 0,
				maxHeight: "45%",
				overflow: "auto",
				borderBottom: "1px solid " + COLORS.border,
				background: "rgba(130,80,223,.05)"
			},
			reviewBoxHeader: {
				display: "flex",
				alignItems: "center",
				justifyContent: "space-between",
				padding: "6px 12px",
				fontSize: "12px",
				fontWeight: 600,
				position: "sticky",
				top: 0,
				background: "inherit"
			},
			reviewText: {
				margin: 0,
				padding: "0 12px 10px",
				fontSize: "12px",
				lineHeight: "1.6",
				whiteSpace: "pre-wrap",
				wordBreak: "break-word"
			},
			list: { flex: 1, overflow: "auto" },
			fileHeader: {
				display: "flex",
				alignItems: "center",
				gap: "8px",
				padding: "7px 12px",
				cursor: "pointer",
				userSelect: "none",
				borderBottom: "1px solid " + COLORS.border
			},
			caret: { fontSize: "10px", opacity: .5, width: "10px", flexShrink: 0 },
			filePath: {
				flex: 1,
				overflow: "hidden",
				textOverflow: "ellipsis",
				whiteSpace: "nowrap",
				fontFamily: "ui-monospace, monospace",
				fontSize: "12px",
				direction: "rtl",
				textAlign: "left"
			},
			badge: {
				fontSize: "10px",
				padding: "1px 6px",
				borderRadius: "8px",
				flexShrink: 0
			},
			stats: {
				fontFamily: "ui-monospace, monospace",
				fontSize: "11px",
				flexShrink: 0,
				whiteSpace: "nowrap"
			},
			diffBody: {
				overflowX: "auto",
				borderBottom: "1px solid " + COLORS.border,
				fontFamily: "ui-monospace, monospace",
				fontSize: "11px",
				lineHeight: "1.5"
			},
			diffLine: {
				whiteSpace: "pre",
				paddingLeft: "12px",
				paddingRight: "8px",
				minWidth: "max-content"
			},
			empty: { padding: "24px 12px", textAlign: "center", opacity: .5, fontSize: "12px" },
			syncNote: { padding: "4px 12px", fontSize: "11px", color: "#9a6700", flexShrink: 0 }
		};

		function basename(path) {
			var normalized = String(path || "").replace(/\/+$/, "");
			var index = normalized.lastIndexOf("/");
			return index < 0 ? normalized : normalized.slice(index + 1);
		}

		/**
		* Read a JSON response tolerantly: the host fallback answers unclaimed
		* routes with an EMPTY 404 body (e.g. this plugin's routes before a dsh
		* restart), which makes the native res.json() throw an opaque
		* "Unexpected end of JSON input". Surface a useful message instead.
		*/
		function readJson(res) {
			return res.text().then(function (text) {
				var body = null;
				try { body = text ? JSON.parse(text) : null; } catch (err) { /* non-JSON error page */ }
				if (!res.ok) {
					throw new Error((body && body.error) ||
						(res.status === 404 ? "接口不存在（HTTP 404）——请重启 dsh 实例以加载最新插件" : "HTTP " + res.status));
				}
				return body;
			});
		}

		/** Split a unified diff into per-file sections keyed by the post-image path. */
		function parsePatchSections(patch) {
			var sections = {};
			if (!patch) return sections;
			var parts = patch.split(/^diff --git /m);
			for (var i = 1; i < parts.length; i++) {
				var firstLine = parts[i].split("\n", 1)[0];
				var match = /^a\/(.*) b\/(.*)$/.exec(firstLine);
				var path = match ? match[2] : firstLine;
				sections[path] = "diff --git " + parts[i];
			}
			return sections;
		}

		/** Drop the `diff --git`/`index`/`---`/`+++` headers; keep hunks and content. */
		function diffLines(section) {
			return section.split("\n").filter(function (line) {
				return !/^(diff --git |index |--- |\+\+\+ )/.test(line);
			});
		}

		function diffLineStyle(line) {
			if (line.startsWith("@@")) return { color: COLORS.hunk, background: COLORS.hunkBg };
			if (line.startsWith("+")) return { color: COLORS.add, background: COLORS.addBg };
			if (line.startsWith("-")) return { color: COLORS.del, background: COLORS.delBg };
			return { opacity: .8 };
		}

		function badge(status) {
			var info = STATUS_BADGES[status] || { label: status, color: "#57606a" };
			return h("span", {
				style: Object.assign({}, styles.badge, {
					color: info.color,
					background: "color-mix(in srgb, " + info.color + " 12%, transparent)"
				})
			}, info.label);
		}

		function fileEntry(file, section, closed, onToggle) {
			var children = [
				h("div", {
					key: "head",
					style: styles.fileHeader,
					title: file.path,
					onClick: onToggle,
					onMouseEnter: function (event) { event.currentTarget.style.background = COLORS.hover; },
					onMouseLeave: function (event) { event.currentTarget.style.background = ""; }
				},
					h("span", { style: styles.caret }, closed ? "▸" : "▾"),
					h("span", { style: styles.filePath }, file.path),
					badge(file.status),
					h("span", { style: styles.stats },
						h("span", { style: { color: COLORS.add } }, "+" + file.additions),
						" ",
						h("span", { style: { color: COLORS.del } }, "−" + file.deletions)))
			];
			if (!closed && section) {
				children.push(h("div", { key: "body", style: styles.diffBody },
					diffLines(section).map(function (line, index) {
						return h("div", {
							key: index,
							style: Object.assign({}, styles.diffLine, diffLineStyle(line))
						}, line || " ");
					})));
			}
			return h("div", { key: file.path }, children);
		}

		/**
		* The changes tab body: the working-tree diff of the session's workspace.
		* No manual refresh — the view polls the API every few seconds and only
		* re-renders when the diff actually changed. The seat is session-scoped,
		* so the slot framework passes the session id in props; the host maps it
		* to the session workspace's repo path.
		*/
		function ChangesPanelBody(props) {
			var sessionId = props && props.sessionId;
			var _data = react.useState(null), data = _data[0], setData = _data[1];
			var _error = react.useState(null), error = _error[0], setError = _error[1];
			var _closed = react.useState({}), closed = _closed[0], setClosed = _closed[1];
			var _review = react.useState(null), review = _review[0], setReview = _review[1];
			var _reviewClosed = react.useState(false), reviewClosed = _reviewClosed[0], setReviewClosed = _reviewClosed[1];
			var _models = react.useState(null), models = _models[0], setModels = _models[1];
			// The chosen model as a "provider/model" string; "" means the host default.
			var _choice = react.useState(function () {
				try { return localStorage.getItem(MODEL_KEY) || ""; } catch (err) { return ""; }
			}), choice = _choice[0], setChoice = _choice[1];
			var snapshotRef = react.useRef(null);
			var inflightRef = react.useRef(false);

			// Load the selectable model catalog once; a failure just hides the picker.
			react.useEffect(function () {
				var cancelled = false;
				fetch("/review-panel/api/models")
					.then(readJson)
					.then(function (body) { if (!cancelled) setModels(body); }, function () {});
				return function () { cancelled = true; };
			}, []);

			// A persisted choice whose provider/model vanished falls back to default.
			var choiceValid = !choice || !!(models && models.providers.some(function (provider) {
				return provider.models.some(function (model) {
					return choice === provider.id + "/" + model.id;
				});
			}));
			var effectiveChoice = choiceValid ? choice : "";

			var pickModel = react.useCallback(function (event) {
				var value = event.target.value;
				setChoice(value);
				try { localStorage.setItem(MODEL_KEY, value); } catch (err) {}
			}, []);

			var startReview = react.useCallback(function () {
				if (review && review.status === "running") return;
				var params = new URLSearchParams();
				if (sessionId) params.set("session", sessionId);
				if (effectiveChoice) {
					var slash = effectiveChoice.indexOf("/");
					params.set("provider", effectiveChoice.slice(0, slash));
					params.set("model", effectiveChoice.slice(slash + 1));
				}
				setReview({ status: "running" });
				setReviewClosed(false);
				fetch("/review-panel/api/review/start?" + params.toString(), { method: "POST" })
					.then(readJson)
					.then(function (body) { setReview({ id: body.id, status: "running" }); },
						function (err) { setReview({ status: "error", error: String(err && err.message || err) }); });
			}, [sessionId, review, effectiveChoice]);

			// Poll a running review until the subagent settles.
			var reviewId = review && review.id;
			var reviewRunning = review && review.status === "running" && reviewId;
			react.useEffect(function () {
				if (!reviewRunning) return;
				var timer = setInterval(function () {
					fetch("/review-panel/api/review/status?id=" + encodeURIComponent(reviewId))
						.then(readJson)
						.then(function (body) {
							setReview(function (prev) {
								if (!prev || prev.id !== body.id) return prev;
								if (body.status && body.status !== "running") return body;
								// Still running: adopt the resolved model label once the runner knows it.
								return body.model && !prev.model ? Object.assign({}, prev, { model: body.model }) : prev;
							});
						}, function (err) {
							setReview({ status: "error", error: String(err && err.message || err) });
						});
				}, 2000);
				return function () { clearInterval(timer); };
			}, [reviewRunning, reviewId]);

			var sync = react.useCallback(function (initial) {
				if (inflightRef.current) return;
				inflightRef.current = true;
				var params = new URLSearchParams({ scope: "working-tree" });
				if (sessionId) params.set("session", sessionId);
				fetch("/review-panel/api/changes?" + params.toString())
					.then(readJson)
					.then(function (body) {
						var snapshot = JSON.stringify([body.files, body.patch, body.truncated, body.cwd]);
						if (snapshotRef.current !== snapshot) {
							snapshotRef.current = snapshot;
							setData(body);
						}
						setError(null);
					}, function (err) {
						// Background sync failures keep the last good view; only an
						// initial failure replaces the whole content with the error.
						if (initial) setError(String(err && err.message || err));
					})
					.then(function () { inflightRef.current = false; });
			}, [sessionId]);

			react.useEffect(function () {
				sync(true);
				var timer = setInterval(function () {
					if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
					sync(false);
				}, POLL_MS);
				return function () { clearInterval(timer); };
			}, [sync]);

			var toggle = react.useCallback(function (path) {
				setClosed(function (prev) {
					var next = Object.assign({}, prev);
					next[path] = !prev[path];
					return next;
				});
			}, []);

			var header = null;
			var content;
			if (!data && error) {
				content = h("div", { style: Object.assign({}, styles.empty, { color: COLORS.del, opacity: 1 }) }, error);
			} else if (!data) {
				content = h("div", { style: styles.empty }, "加载中…");
			} else {
				var modelPicker = null;
				if (models && models.providers.some(function (provider) { return provider.models.length > 0; })) {
					var options = [h("option", {
						key: "",
						value: ""
					}, models.default
						? "默认（" + models.default.provider + "/" + models.default.model + "）"
						: "默认模型")];
					models.providers.forEach(function (provider) {
						provider.models.forEach(function (model) {
							var value = provider.id + "/" + model.id;
							options.push(h("option", { key: value, value: value, title: model.name }, value));
						});
					});
					modelPicker = h("select", {
						style: styles.modelSelect,
						value: effectiveChoice,
						disabled: !!(review && review.status === "running"),
						title: "检视使用的模型",
						onChange: pickModel
					}, options);
				}
				header = h("div", { style: styles.header },
					h("div", { style: styles.headerRow },
						h("div", { style: styles.repoName, title: data.cwd }, basename(data.cwd)),
						h("div", { style: { display: "flex", alignItems: "center", gap: "6px", flexShrink: 0 } },
							modelPicker,
							h("button", {
								style: styles.reviewButton,
								disabled: review && review.status === "running",
								onClick: startReview
							}, review && review.status === "running" ? "检视中…" : "开始检视"))),
					h("div", { style: styles.headerMeta },
						data.files.length + " 个文件变更 · 自动同步" + (data.truncated ? " · diff 已截断" : "")));
				if (data.files.length === 0) {
					content = h("div", { style: styles.empty }, "工作区干净，没有未提交的变更");
				} else {
					var sections = parsePatchSections(data.patch);
					content = h("div", { style: styles.list },
						data.files.map(function (file) {
							return fileEntry(file, sections[file.path], !!closed[file.path], function () { toggle(file.path); });
						}));
				}
			}

			var reviewSection = null;
			if (review) {
				var reviewTitle = review.status === "running" ? "智能体检视中…"
					: review.status === "done" ? "检视结论"
					: "检视失败";
				if (review.model) reviewTitle += " · " + review.model;
				var reviewBody = reviewClosed ? null
					: review.status === "running" ? h("pre", { style: styles.reviewText }, "独立智能体正在阅读 diff，通常需要几十秒…")
					: h("pre", {
						style: Object.assign({}, styles.reviewText,
							review.status === "error" ? { color: COLORS.del } : null)
					}, review.text || review.error || "(无输出)");
				reviewSection = h("div", { style: styles.reviewBox },
					h("div", { style: styles.reviewBoxHeader },
						h("span", null, reviewTitle),
						h("span", {
							style: { cursor: "pointer", opacity: .5, fontSize: "10px" },
							onClick: function () { setReviewClosed(!reviewClosed); }
						}, reviewClosed ? "▸ 展开" : "▾ 收起")),
					reviewBody);
			}

			return h("div", { style: styles.root },
				header,
				reviewSection,
				data && error ? h("div", { style: styles.syncNote }, "同步失败，稍后自动重试：" + error) : null,
				content);
		}

		/** Required client services: the slot registry and the right-sidebar tab registry. */
		var inject = ["slots", "sidebarRightTabs"];

		/**
		* Client plugin body: register the tab type (stage one) and its body
		* (stage two). Both registrations live exactly as long as this plugin.
		*/
		function apply(ctx) {
			ctx.effect(function () {
				return ctx.sidebarRightTabs.register({
					id: TAB_ID,
					kind: KIND,
					title: function () { return "代码变更"; },
					guide: [{
						order: 100,
						title: function () { return "代码变更"; },
						description: function () { return "查看当前仓库未提交的代码变更（diff）"; }
					}]
				});
			}, "dsh-review-panel: tab type");
			ctx.effect(function () {
				return ctx.slots.inject("sidebar.right.pane.tab", function () {
					return ctx.slots.register({ name: "sidebar.right.pane.tab", key: TAB_ID }, ChangesPanelBody);
				});
			}, "dsh-review-panel: tab body");
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
