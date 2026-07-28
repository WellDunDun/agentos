import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowRight, Plus } from "lucide-react";
import { useRef, useState } from "react";
import { appUrl, formatUpdatedAt } from "../api";
import { toast } from "../components/Toaster";
import { SystemPromptModal } from "../components/modals";
import { useApps, useCreateApp } from "../hooks";

// One suggestion per agentOS Apps capability: SQLite, workflows + queues,
// multiplayer, agents + cron.
const SUGGESTIONS = [
	"A todo app that stores tasks in SQLite",
	"An order tracker with a durable approval workflow and queue",
	"A multiplayer retro board with live presence",
	"An agent that summarizes new signups every morning on a cron",
];

const STATUS_LABEL = { live: "Live", building: "Building", failed: "Build failed" } as const;

export function Landing() {
	const { data: apps } = useApps();
	const createApp = useCreateApp();
	const navigate = useNavigate();
	const [showPrompt, setShowPrompt] = useState(false);
	const [text, setText] = useState("");
	const [creating, setCreating] = useState(false);
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	async function create() {
		const prompt = text.trim();
		if (!prompt) {
			toast("Describe the app first.");
			return;
		}
		if (creating) return;
		setCreating(true);
		try {
			const app = await createApp.mutateAsync(prompt);
			navigate({ to: "/app/$appId", params: { appId: app.id } });
		} catch (error) {
			toast(`Create failed: ${error instanceof Error ? error.message : error}`);
		} finally {
			setCreating(false);
		}
	}

	return (
		<div className="landing">
			<nav className="nav">
				<div className="logo-mark">OS</div>
				<div className="title">
					agentOS <span>/ App Builder</span>
				</div>
				<div className="right">
					<a
						className="btn ghost"
						href="https://agentos-sdk.dev/docs/apps"
						target="_blank"
						rel="noreferrer"
					>
						Docs
					</a>
					<button type="button" className="btn ghost" onClick={() => setShowPrompt(true)}>
						System prompt
					</button>
				</div>
			</nav>

			<section className="hero">
				<h1>What should we build?</h1>
				<p>
					Describe an app. The agent writes it, deploys it with <code>deployApp()</code>, and
					tests the live deployment.
				</p>
				<p className="hero-caps">
					Apps get durable <b>SQLite</b>, realtime <b>WebSockets</b>, <b>workflows</b>,{" "}
					<b>cron schedules</b>, and <b>queues</b> out of the box.
				</p>
				<div className="prompt-card">
					<textarea
						ref={textareaRef}
						placeholder="An expense tracker for my team with a weekly summary page…"
						value={text}
						onChange={(e) => setText(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && !e.shiftKey) {
								e.preventDefault();
								create();
							}
						}}
					/>
					<div className="row">
						<div className="hint">⏎ to create · ⇧⏎ for a new line</div>
						<button type="button" className="btn primary" disabled={creating} onClick={create}>
							{creating ? "Creating…" : "Create app"}
							<ArrowRight size={14} />
						</button>
					</div>
				</div>
				<div className="suggestions">
					{SUGGESTIONS.map((s) => (
						<button
							type="button"
							key={s}
							onClick={() => {
								setText(s);
								textareaRef.current?.focus();
							}}
						>
							{s}
						</button>
					))}
				</div>
			</section>

			<section className="apps-section">
				<h2>Your apps</h2>
				<div className="apps-grid">
					{(apps ?? []).map((app) => (
						<Link className="app-card" to="/app/$appId" params={{ appId: app.id }} key={app.id}>
							<div className="thumb">
								{app.release > 0 ? (
									<iframe
										title={app.name}
										loading="lazy"
										sandbox="allow-scripts allow-same-origin"
										src={appUrl(app.id)}
									/>
								) : (
									<div className="thumb-empty">no deploy yet</div>
								)}
							</div>
							<div className="meta">
								<div className="name-row">
									<div className="name">{app.name}</div>
									<span className={`chip ${app.status}`}>
										<span className="dot" />
										{STATUS_LABEL[app.status]}
									</span>
								</div>
								<div className="sub">
									<code>/apps/{app.id}/</code> · release #{app.release} ·{" "}
									{formatUpdatedAt(app.updatedAt)}
								</div>
							</div>
						</Link>
					))}
					<button
						type="button"
						className="app-card new"
						onClick={() => {
							textareaRef.current?.focus();
							window.scrollTo({ top: 0, behavior: "smooth" });
						}}
					>
						<div className="plus">
							<Plus size={18} />
						</div>
						<div>Create new app</div>
					</button>
				</div>
			</section>

			{showPrompt && <SystemPromptModal onClose={() => setShowPrompt(false)} />}
		</div>
	);
}
