export interface AgentOSAppsErrorOptions {
	/** Marks a host/platform failure that cannot be repaired by changing app source. */
	serverFault?: boolean;
	cause?: unknown;
}

export class AgentOSAppsError extends Error {
	readonly code: string;
	readonly metadata?: Record<string, unknown>;
	readonly serverFault: boolean;

	constructor(
		code: string,
		message: string,
		metadata?: Record<string, unknown>,
		options: AgentOSAppsErrorOptions = {},
	) {
		super(
			message,
			options.cause === undefined ? undefined : { cause: options.cause },
		);
		this.name = "AgentOSAppsError";
		this.code = code;
		this.metadata = metadata;
		this.serverFault = options.serverFault ?? false;
	}
}
