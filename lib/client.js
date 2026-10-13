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
			headerMeta: { marginTop: "2px", fontSize: "11px", opacity: .6 },
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
			var snapshotRef = react.useRef(null);
			var inflightRef = react.useRef(false);

			var sync = react.useCallback(function (initial) {
				if (inflightRef.current) return;
				inflightRef.current = true;
				var params = new URLSearchParams({ scope: "working-tree" });
				if (sessionId) params.set("session", sessionId);
				fetch("/review-panel/api/changes?" + params.toString())
					.then(function (res) {
						return res.json().then(function (body) {
							if (!res.ok) throw new Error(body.error || ("HTTP " + res.status));
							return body;
						});
					})
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
				header = h("div", { style: styles.header },
					h("div", { style: styles.repoName, title: data.cwd }, basename(data.cwd)),
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

			return h("div", { style: styles.root },
				header,
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
