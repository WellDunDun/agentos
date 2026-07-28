// Renders the typed blocks that make up an agent message — the same shapes
// the backend streams over SSE.
import {
	Check,
	ChevronRight,
	CloudUpload,
	FilePenLine,
	Globe,
	ScrollText,
	X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Block, ChatMessage } from "../types";

const ICON = 13;

function Typewriter(props: { text: string; onTick?: () => void }) {
	const [count, setCount] = useState(0);
	const words = props.text.split(" ");
	const onTick = useRef(props.onTick);
	onTick.current = props.onTick;
	useEffect(() => {
		setCount(0);
		const timer = setInterval(() => {
			setCount((c) => {
				if (c >= words.length) {
					clearInterval(timer);
					return c;
				}
				onTick.current?.();
				return c + 1;
			});
		}, 24);
		return () => clearInterval(timer);
	}, [props.text, words.length]);
	return <p>{words.slice(0, count).join(" ")}</p>;
}

export function BlockView(props: { block: Block; onGrow?: () => void }) {
	const b = props.block;
	switch (b.kind) {
		case "text":
			return b.animate ? (
				<Typewriter text={b.text} onTick={props.onGrow} />
			) : (
				<p>{b.text}</p>
			);
		case "file":
			return (
				<div className="event">
					<span className="ico">
						<FilePenLine size={ICON} />
					</span>
					<span>Wrote</span>
					<code>{b.path}</code>
				</div>
			);
		case "deploy":
			return (
				<>
					<div className="event">
						<span className="ico">
							{b.pending ? <span className="spinner" /> : <CloudUpload size={ICON} />}
						</span>
						<span>{b.pending ? "Deploying" : b.ok ? "Deployed" : "Build failed"}</span>
						<code>release #{b.release}</code>
						{!b.pending && (
							<span className={`status ${b.ok ? "ok" : "err"}`}>
								{b.ok ? "live" : "diagnostics"}
							</span>
						)}
					</div>
					{!b.pending && !b.ok && b.diagnostics && (
						<details className="diag" open>
							<summary>
								<ChevronRight size={12} /> Build diagnostics — previous release still serving
							</summary>
							<pre>{b.diagnostics}</pre>
						</details>
					)}
				</>
			);
		case "http-tests":
			if (b.pending) {
				return (
					<div className="event">
						<span className="ico">
							<span className="spinner" />
						</span>
						<span>Testing the live deployment…</span>
					</div>
				);
			}
			return (
				<>
					{(b.rows ?? []).map((row, i) => {
						const ok = row.status > 0 && row.status < 400;
						return (
							<div className="event test-row" key={`${row.method}-${row.path}-${i}`}>
								<span className={`ico ${ok ? "ok" : "err"}`}>
									{ok ? <Check size={ICON} /> : <X size={ICON} />}
								</span>
								<code>
									<b>{row.method}</b> {row.path}
								</code>
								<span className={`status ${ok ? "ok" : "err"}`}>
									{row.status || "ERR"} · {row.ms}ms
								</span>
							</div>
						);
					})}
				</>
			);
		case "logs":
			if (b.pending) {
				return (
					<div className="event">
						<span className="ico">
							<span className="spinner" />
						</span>
						<span>Reading runtime logs…</span>
					</div>
				);
			}
			return (
				<div className="event">
					<span className="ico ok">
						<ScrollText size={ICON} />
					</span>
					<span>Runtime logs</span>
					<span className="status ok">{b.summary}</span>
				</div>
			);
		case "browser-test":
			if (b.pending) {
				return (
					<div className="event">
						<span className="ico">
							<span className="spinner" />
						</span>
						<span>Browser check…</span>
					</div>
				);
			}
			return (
				<>
					{(b.checks ?? []).map((check) => {
						const bad = check.startsWith("MISSING") || check.includes("failed");
						const errCount = /^(\d+) console errors/.exec(check);
						const isErr = bad || (errCount ? Number(errCount[1]) > 0 : false);
						return (
							<div className="event test-row" key={check}>
								<span className={`ico ${isErr ? "err" : "ok"}`}>
									{isErr ? <X size={ICON} /> : <Globe size={ICON} />}
								</span>
								<span>Browser check</span>
								<span className={`status ${isErr ? "err" : "ok"}`}>{check}</span>
							</div>
						);
					})}
				</>
			);
	}
}

export function MessageView(props: { message: ChatMessage; onGrow?: () => void }) {
	const { message } = props;
	if (message.role === "user") {
		return (
			<div className="msg user">
				<div className="bubble">{message.text}</div>
			</div>
		);
	}
	return (
		<div className="msg agent">
			<div className="avatar">OS</div>
			<div className="content">
				{(message.blocks ?? []).map((block, i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: append-only stream
					<BlockView block={block} key={i} onGrow={props.onGrow} />
				))}
			</div>
		</div>
	);
}
