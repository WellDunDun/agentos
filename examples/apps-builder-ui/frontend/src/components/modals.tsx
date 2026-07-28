import type { ReactNode } from "react";
import { useInspectorInfo, useSystemPrompt } from "../hooks";

function Modal(props: {
	title: string;
	subtitle: string;
	onClose: () => void;
	children: ReactNode;
}) {
	return (
		<div
			className="modal-backdrop"
			onClick={(e) => {
				if (e.target === e.currentTarget) props.onClose();
			}}
		>
			<div className="modal">
				<header>
					<div>
						<div className="t">{props.title}</div>
						<div className="s">{props.subtitle}</div>
					</div>
					<button type="button" className="btn" onClick={props.onClose}>
						Close
					</button>
				</header>
				<div className="body">{props.children}</div>
			</div>
		</div>
	);
}

export function SystemPromptModal(props: { onClose: () => void }) {
	const { data } = useSystemPrompt();
	return (
		<Modal
			title="Agent system prompt"
			subtitle="Sent with every user message, along with the app's current files"
			onClose={props.onClose}
		>
			<pre>{data ?? "Loading…"}</pre>
		</Modal>
	);
}

export function InspectorModal(props: { appId: string; onClose: () => void }) {
	const { data } = useInspectorInfo(props.appId);
	return (
		<Modal
			title="Open Rivet Inspector"
			subtitle="Resolved server-side from the host's Rivet connection"
			onClose={props.onClose}
		>
			<p className="note">
				Deployment actor: <code>{data?.deploymentActor}</code> in namespace{" "}
				<code>{data?.namespace}</code> on <code>{data?.endpoint}</code>{" "}
				(resolved from <code>RIVET_ENGINE</code> / <code>RIVET_ENDPOINT</code>{" "}
				/ <code>RIVET_NAMESPACE</code> via{" "}
				<code>GET /api/apps/:id/inspector</code>).
			</p>
			<div className="inspector-row">
				<div className="label">Self-hosted engine</div>
				<div className="url">{data?.selfHostedUrl}</div>
				<a
					className="btn"
					href={data?.selfHostedUrl}
					target="_blank"
					rel="noreferrer"
				>
					Open ↗
				</a>
			</div>
			<div className="inspector-row">
				<div className="label">Rivet Cloud</div>
				<div className="url">{data?.cloudUrl}</div>
				<a className="btn" href={data?.cloudUrl} target="_blank" rel="noreferrer">
					Open ↗
				</a>
			</div>
			<p className="note" style={{ marginTop: 4 }}>
				Open question: the exact inspector page/deep-link format for each
				surface, and whether it should land on the deployment actor or the
				app's generated actors.
			</p>
		</Modal>
	);
}
