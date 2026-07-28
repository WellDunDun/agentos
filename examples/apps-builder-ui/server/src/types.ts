// Wire types shared with the frontend (frontend/src/mock/types.ts mirrors
// these — keep the two in sync when either changes).

export type AppStatus = "live" | "building" | "failed";

export interface AppSummary {
	id: string;
	name: string;
	status: AppStatus;
	release: number;
	updatedAt: number;
	prompt: string;
}

export interface AppDetail extends AppSummary {
	messages: ChatMessage[];
	files: Record<string, string>;
}

export interface ChatMessage {
	role: "user" | "agent";
	text?: string;
	blocks?: Block[];
}

export type Block =
	| { kind: "text"; text: string; animate?: boolean }
	| { kind: "file"; path: string }
	| {
			kind: "deploy";
			release: number;
			pending?: boolean;
			ok?: boolean;
			diagnostics?: string;
	  }
	| { kind: "http-tests"; pending?: boolean; rows?: HttpTestRow[] }
	| { kind: "logs"; pending?: boolean; summary?: string }
	| { kind: "browser-test"; pending?: boolean; checks?: string[] };

export interface HttpTestRow {
	method: string;
	path: string;
	status: number;
	ms: number;
}

export type AgentEvent =
	| { type: "status"; status: AppStatus; release?: number }
	| { type: "block"; block: Block; replaceLast?: boolean }
	| { type: "overlay"; text: string | null }
	| { type: "preview-reload" }
	| { type: "done" }
	| { type: "error"; message: string };
