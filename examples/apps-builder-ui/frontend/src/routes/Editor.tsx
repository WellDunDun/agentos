import { useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import {
	ArrowLeft,
	ExternalLink,
	Lock,
	Monitor,
	RotateCw,
	SearchCode,
	Smartphone,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import * as api from "../api";
import { MessageView } from "../components/blocks";
import { InspectorModal, SystemPromptModal } from "../components/modals";
import { toast } from "../components/Toaster";
import { useApp } from "../hooks";
import type { AppStatus, ChatMessage } from "../types";

const routeApi = getRouteApi("/app/$appId");

function escapeHtml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Single pass so injected spans are never re-matched by later rules.
function highlight(code: string): string {
	return escapeHtml(code).replace(
		/(\/\/[^\n]*)|(&quot;[^\n]*?&quot;|`[^`]*`)|\b(import|from|export|const|let|return|function|async|await|default|new|if|as|private|true|false)\b/g,
		(_m, comment, str, keyword) =>
			comment
				? `<span class="tok-c">${comment}</span>`
				: str
					? `<span class="tok-s">${str}</span>`
					: `<span class="tok-k">${keyword}</span>`,
	);
}

export function Editor() {
	const { appId } = routeApi.useParams();
	const { data: app } = useApp(appId);
	const queryClient = useQueryClient();

	const [tab, setTab] = useState<"preview" | "code">("preview");
	const [viewport, setViewport] = useState<"desktop" | "mobile">("desktop");
	const [messages, setMessages] = useState<ChatMessage[] | null>(null);
	const [status, setStatus] = useState<AppStatus | null>(null);
	const [release, setRelease] = useState<number | null>(null);
	const [overlay, setOverlay] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [input, setInput] = useState("");
	const [activeFile, setActiveFile] = useState<string | null>(null);
	const [frameNonce, setFrameNonce] = useState(0);
	const [showPrompt, setShowPrompt] = useState(false);
	const [showInspector, setShowInspector] = useState(false);
	const scrollRef = useRef<HTMLDivElement>(null);
	const startedRef = useRef(false);

	const displayMessages = messages ?? app?.messages ?? [];
	const displayStatus: AppStatus = status ?? app?.status ?? "building";
	const displayRelease = release ?? app?.release ?? 0;

	const files = app?.files ?? {};
	const fileNames = Object.keys(files).sort();
	const currentFile =
		activeFile && files[activeFile] !== undefined
			? activeFile
			: (fileNames.find((f) => f === "src/index.ts") ?? fileNames[0] ?? null);

	const frameSrc = useMemo(() => {
		if (displayRelease <= 0) return null;
		return `${api.appUrl(appId)}?r=${displayRelease}-${frameNonce}`;
	}, [appId, displayRelease, frameNonce]);

	function scrollToBottom() {
		const el = scrollRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}
	const blockCount = displayMessages.reduce((n, m) => n + (m.blocks?.length ?? 0), 0);
	// biome-ignore lint/correctness/useExhaustiveDependencies: scroll on append
	useEffect(scrollToBottom, [displayMessages.length, blockCount]);

	async function run(prompt: string) {
		if (!app || busy) return;
		setBusy(true);
		const base = messages ?? app.messages;
		let current: ChatMessage[] = [
			...base,
			{ role: "user", text: prompt },
			{ role: "agent", blocks: [] },
		];
		setMessages(current);
		try {
			await api.sendPrompt(appId, prompt, (event) => {
				switch (event.type) {
					case "block": {
						const incoming =
							event.block.kind === "text"
								? { ...event.block, animate: true }
								: event.block;
						const last = current[current.length - 1];
						const blocks = [...(last.blocks ?? [])];
						if (event.replaceLast) blocks[blocks.length - 1] = incoming;
						else blocks.push(incoming);
						current = [...current.slice(0, -1), { ...last, blocks }];
						setMessages(current);
						break;
					}
					case "status":
						setStatus(event.status);
						if (event.release !== undefined) setRelease(event.release);
						break;
					case "overlay":
						setOverlay(event.text);
						break;
					case "preview-reload":
						setFrameNonce((n) => n + 1);
						break;
					case "error":
						toast(`Agent error: ${event.message}`);
						break;
					case "done":
						break;
				}
			});
		} catch (error) {
			toast(`Run failed: ${error instanceof Error ? error.message : error}`);
		}
		setBusy(false);
		setOverlay(null);
		queryClient.invalidateQueries({ queryKey: ["apps"] });
	}

	// Auto-run the landing prompt for freshly created apps.
	// biome-ignore lint/correctness/useExhaustiveDependencies: run once per app load
	useEffect(() => {
		if (!app || startedRef.current) return;
		startedRef.current = true;
		api.takePendingFirstPrompt(appId).then((pending) => {
			if (pending) run(pending);
		});
	}, [app, appId]);

	function send() {
		const text = input.trim();
		if (!text || busy) return;
		setInput("");
		run(text);
	}

	if (!app) return null;

	const statusLabel =
		displayStatus === "live"
			? `Live · release #${displayRelease}`
			: displayStatus === "building"
				? "Building…"
				: `Build failed${displayRelease > 0 ? ` · serving #${displayRelease}` : ""}`;

	return (
		<div className="editor">
			<header className="editor-header">
				<Link className="btn ghost icon" title="Back to apps" to="/">
					<ArrowLeft size={14} />
				</Link>
				<div className="logo-mark" style={{ width: 22, height: 22, fontSize: 8, borderWidth: 2 }}>
					OS
				</div>
				<div className="name">{app.name}</div>
				<span className={`chip ${displayStatus}`}>
					<span className="dot" />
					{statusLabel}
				</span>
				<div className="right">
					<a className="btn" href={api.appUrl(appId)} target="_blank" rel="noreferrer">
						<ExternalLink size={14} />
						Open app
					</a>
					<button type="button" className="btn primary" onClick={() => setShowInspector(true)}>
						<SearchCode size={14} />
						Open Inspector
					</button>
				</div>
			</header>

			<div className="editor-body">
				<aside className="chat-panel">
					<div className="chat-head">
						Agent
						<button type="button" className="btn ghost" onClick={() => setShowPrompt(true)}>
							View system prompt
						</button>
					</div>
					<div className="chat-scroll" ref={scrollRef}>
						{displayMessages.map((message, i) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: append-only list
							<MessageView message={message} key={i} onGrow={scrollToBottom} />
						))}
					</div>
					<div className="chat-input">
						<div className="box">
							<textarea
								placeholder="Describe a change…"
								value={input}
								onChange={(e) => setInput(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter" && !e.shiftKey) {
										e.preventDefault();
										send();
									}
								}}
							/>
							<div className="row">
								<div className="hint">Deploys straight to the live app</div>
								<button type="button" className="btn primary" disabled={busy} onClick={send}>
									{busy ? "Working…" : "Send"}
								</button>
							</div>
						</div>
					</div>
				</aside>

				<main className="preview-panel">
					<div className="preview-toolbar">
						<div className="tabs">
							<button
								type="button"
								className={tab === "preview" ? "active" : ""}
								onClick={() => setTab("preview")}
							>
								Preview
							</button>
							<button
								type="button"
								className={tab === "code" ? "active" : ""}
								onClick={() => setTab("code")}
							>
								Code
							</button>
						</div>
						<div className="url-pill">
							<Lock className="lock" size={11} />
							<span>
								{window.location.host}
								<b>/apps/{appId}/</b>
							</span>
						</div>
						<div className="viewport-toggle">
							<button
								type="button"
								className={`btn ghost icon${viewport === "desktop" ? " active" : ""}`}
								title="Desktop"
								onClick={() => setViewport("desktop")}
							>
								<Monitor size={14} />
							</button>
							<button
								type="button"
								className={`btn ghost icon${viewport === "mobile" ? " active" : ""}`}
								title="Mobile"
								onClick={() => setViewport("mobile")}
							>
								<Smartphone size={14} />
							</button>
						</div>
						<button
							type="button"
							className="btn ghost icon"
							title="Reload preview"
							onClick={() => setFrameNonce((n) => n + 1)}
						>
							<RotateCw size={14} />
						</button>
					</div>

					{tab === "preview" ? (
						<div className="preview-stage">
							<div className={`frame-wrap${viewport === "mobile" ? " mobile" : ""}`}>
								{frameSrc ? (
									<iframe title="App preview" src={frameSrc} />
								) : (
									<div className="frame-empty">
										<div className="logo-mark" style={{ borderColor: "#b6b0a4", color: "#8a857b" }}>
											OS
										</div>
										<div>Waiting for the first deploy…</div>
									</div>
								)}
								<div className={`frame-overlay${overlay ? " show" : ""}`}>
									<div className="spinner" />
									<div>{overlay}</div>
								</div>
							</div>
						</div>
					) : (
						<div className="code-view">
							<div className="file-list">
								<div className="group">Files</div>
								{fileNames.length === 0 && <div className="group">none yet</div>}
								{fileNames.map((path) => (
									<button
										type="button"
										key={path}
										className={path === currentFile ? "active" : ""}
										onClick={() => setActiveFile(path)}
									>
										{path}
									</button>
								))}
							</div>
							<div className="code-pane">
								<pre
									// biome-ignore lint/security/noDangerouslySetInnerHtml: escaped upstream
									dangerouslySetInnerHTML={{
										__html: highlight(currentFile ? (files[currentFile] ?? "") : ""),
									}}
								/>
							</div>
						</div>
					)}
				</main>
			</div>

			{showPrompt && <SystemPromptModal onClose={() => setShowPrompt(false)} />}
			{showInspector && <InspectorModal appId={appId} onClose={() => setShowInspector(false)} />}
		</div>
	);
}
